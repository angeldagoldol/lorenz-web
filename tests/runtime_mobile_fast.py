import asyncio
import base64
import json
import re
import time
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / 'index.html').read_text(encoding='utf-8')
HTML = re.sub(r'<meta http-equiv="Content-Security-Policy"[\s\S]*?>\s*', '', HTML, count=1, flags=re.I)
HTML = re.sub(r'<link[^>]+href="https://[^>]+>\s*', '', HTML, flags=re.I)
HTML = re.sub(r'<link\b[^>]*rel="stylesheet"[^>]*>\s*', '', HTML, flags=re.I)
HTML = re.sub(r'<script[^>]+src="[^"]+"[^>]*></script>\s*', '', HTML, flags=re.I)
HTML = HTML.replace('<head>', '<head><base href="https://dagoldol.test/">', 1)
SNAPSHOT = (ROOT / 'catalogue-snapshot.json').read_text(encoding='utf-8')
ROUTES = (ROOT / 'product-routes.json').read_text(encoding='utf-8')
CSS = '\n'.join((ROOT / f).read_text(encoding='utf-8') for f in ['style.css', 'pill-buttons.css', 'phase2-fixes.css', 'phase3-fixes.css'])
BG_DATA = base64.b64encode((ROOT / 'assets/mobile-liquid-chrome.webp').read_bytes()).decode('ascii')
CSS = CSS.replace('url("./assets/mobile-liquid-chrome.webp")', f'url("data:image/webp;base64,{BG_DATA}")')
SCRIPT = (ROOT / 'script.js').read_text(encoding='utf-8')
CONFIG = (ROOT / 'config.js').read_text(encoding='utf-8').replace('PHASE2_ENABLED: true', 'PHASE2_ENABLED: false').replace('PHASE3_ENABLED: true', 'PHASE3_ENABLED: false')

SUPABASE_STUB = r'''
(() => {
  function slowResult(){
    return new Promise(resolve => setTimeout(() => resolve({ data: null, error: { message: 'simulated slow mobile network' } }), 1600));
  }
  function query(){
    const q = {
      select(){ return q; }, order(){ return q; }, eq(){ return q; }, neq(){ return q; }, in(){ return q; }, limit(){ return q; }, range(){ return q; },
      single(){ return q; }, maybeSingle(){ return q; }, update(){ return q; }, insert(){ return q; }, upsert(){ return q; }, delete(){ return q; },
      then(resolve, reject){ return slowResult().then(resolve, reject); }
    };
    return q;
  }
  window.supabase = {
    createClient(){
      return {
        auth: {
          async getSession(){ return { data: { session: null }, error: null }; },
          async signOut(){ return { error: null }; },
          async updateUser(){ return { error: null }; },
          onAuthStateChange(){ return { data: { subscription: { unsubscribe(){} } } }; }
        },
        from(){ return query(); },
        rpc(){ return slowResult(); },
        channel(){ return { on(){ return this; }, subscribe(){ return this; } }; },
        removeChannel(){},
        storage: { from(){ return { upload: async()=>({error:{message:'stub'}}), getPublicUrl:()=>({data:{publicUrl:''}}), remove:async()=>({error:null}) }; } }
      };
    }
  };
})();
'''

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        results = []
        for width, height in [(320, 700), (360, 780), (390, 844), (414, 896), (430, 932)]:
            context = await browser.new_context(viewport={'width': width, 'height': height}, is_mobile=True, has_touch=True, device_scale_factor=2)
            page = await context.new_page()
            errors = []
            page.on('pageerror', lambda exc, errors=errors: errors.append(str(exc)))
            await page.set_content(HTML, wait_until='domcontentloaded')
            await page.add_style_tag(content=CSS)
            await page.evaluate("history.pushState=()=>{};history.replaceState=()=>{};")
            await page.add_script_tag(content=SUPABASE_STUB)
            await page.add_script_tag(content=CONFIG)
            await page.evaluate(f'''() => {{
              const snapshotText = {SNAPSHOT!r};
              const routesText = {ROUTES!r};
              window.fetch = async (url) => {{
                const text = String(url);
                if (text.includes('catalogue-snapshot.json')) return new Response(snapshotText, {{status:200, headers:{{'Content-Type':'application/json'}}}});
                if (text.includes('product-routes.json')) return new Response(routesText, {{status:200, headers:{{'Content-Type':'application/json'}}}});
                return new Response('', {{status:404}});
              }};
              const bg = document.getElementById('liquid-chrome-bg-shop');
              bg.classList.add('liquid-chrome-static');
              bg.dataset.liquidChromeMode = 'static';
            }}''')
            start = time.perf_counter()
            await page.add_script_tag(content=SCRIPT)
            await page.wait_for_selector('#catalogue .product-card', timeout=1000)
            elapsed = (time.perf_counter() - start) * 1000
            count = await page.locator('#catalogue .product-card').count()
            overflow = await page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
            bg = await page.locator('#liquid-chrome-bg-shop').evaluate('el => getComputedStyle(el).backgroundImage')
            results.append((width, elapsed, count, overflow, 'data:image/webp' in bg, errors))
            await context.close()
        await browser.close()

    for width, elapsed, count, overflow, rich, errors in results:
        print(f'width={width} first_cards_ms={elapsed:.1f} cards={count} overflow={overflow} static_bg={rich} errors={errors}')
    assert all(r[1] < 1000 for r in results), results
    assert all(r[2] >= 1 for r in results), results
    assert all(r[3] == 0 for r in results), results
    assert all(r[4] for r in results), results
    assert all(not r[5] for r in results), results

if __name__ == '__main__':
    asyncio.run(main())
