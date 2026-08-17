import asyncio
import json
import threading
from contextlib import contextmanager
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]

SNAPSHOT = {
    "version": 1,
    "generatedAt": "2026-08-16T00:00:00.000Z",
    "products": [
        {
            "id": "pmsgomk3z",
            "name": "benguet pine",
            "description": "Pinus kesiya test snapshot",
            "accent": "#4fe3c1",
            "icon": "",
            "brand_id": None,
            "unit_type": "feet",
            "sizes": [{"feet": 2, "price": 20, "stock": 12, "image": "/tests/fixture-product.svg"}],
        },
        {
            "id": "pmsgowyr2",
            "name": "durian tree",
            "description": "Durian test snapshot",
            "accent": "#ff8a5b",
            "icon": "",
            "brand_id": None,
            "unit_type": "feet",
            "sizes": [{"feet": 8, "price": 600, "stock": 8, "image": "/tests/fixture-product.svg"}],
        },
        {
            "id": "pmsdumr9l",
            "name": "norfolk pine tree",
            "description": "Norfolk pine test snapshot",
            "accent": "#626b80",
            "icon": "",
            "brand_id": None,
            "unit_type": "feet",
            "sizes": [{"feet": 4, "price": 199, "stock": 5, "image": "/tests/fixture-product.svg"}],
        },
    ],
    "brands": [],
    "ratings": [],
    "flashSales": [],
    "settings": [
        {"key": "shop_logo_image", "value": "/tests/fixture-product.svg"},
        {"key": "gcash_number", "value": "0963 202 0564"}
    ],
}

MOCK_SUPABASE_CDN = r'''
(() => {
  class Query {
    constructor(table) { this.table = table; this.filters = []; }
    select() { return this; }
    order() { return this; }
    eq(k,v) { this.filters.push([k,v]); return this; }
    neq() { return this; }
    ilike() { return this; }
    or() { return this; }
    range() { return this; }
    limit() { return this; }
    insert() { return Promise.resolve({data:null,error:null}); }
    update() { return this; }
    upsert() { return Promise.resolve({data:null,error:null}); }
    delete() { return this; }
    maybeSingle() { return Promise.resolve({data:null,error:null}); }
    single() { return Promise.resolve({data:null,error:{message:'not found'}}); }
    then(resolve,reject) {
      const result = (this.table === 'products' || this.table === 'settings')
        ? {data:null,error:{message:'simulated mobile public-data request failure'}}
        : {data:[],error:null};
      return Promise.resolve(result).then(resolve,reject);
    }
  }

  const channel = {
    on(){ return this; },
    subscribe(cb){ if (cb) setTimeout(() => cb('SUBSCRIBED'), 0); return this; },
    track(){ return Promise.resolve(); },
    presenceState(){ return {}; }
  };

  const client = {
    auth: {
      async getSession(){ return {data:{session:null},error:null}; },
      onAuthStateChange(){ return {data:{subscription:{unsubscribe(){}}}}; },
      async signOut(){ return {error:null}; },
      async signInWithPassword(){ return {data:{user:null},error:{message:'mock'}}; },
      async signUp(){ return {data:{user:null},error:{message:'mock'}}; },
      async resetPasswordForEmail(){ return {data:{},error:null}; },
      async updateUser(){ return {data:{},error:null}; }
    },
    from(table){ return new Query(table); },
    async rpc(name){
      if (name === 'get_public_recommendation_signals') {
        return {data:{trending:{},cooccurrence:{}},error:null};
      }
      return {data:null,error:null};
    },
    channel(){ return Object.create(channel); },
    removeChannel(){},
    storage: {
      from(){
        return {
          async upload(){ return {error:null}; },
          getPublicUrl(){ return {data:{publicUrl:'/tests/fixture-product.svg'}}; },
          async createSignedUrl(path){ return {data:{signedUrl:path},error:null}; },
          async remove(){ return {error:null}; }
        };
      }
    },
    functions: { async invoke(){ return {data:{ok:true},error:null}; } }
  };

  window.supabase = { createClient(){ return client; } };
})();
'''

async def run_test():
    import re
    index_html = (ROOT / "index.html").read_text(encoding="utf-8")
    index_html = re.sub(r'<script\b[^>]*src="[^"]+"[^>]*></script>', '', index_html, flags=re.I)
    index_html = re.sub(r'<link\b[^>]*rel="stylesheet"[^>]*>', '', index_html, flags=re.I)
    index_html = re.sub(r'<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?>', '', index_html, count=1, flags=re.I)
    index_html = index_html.replace('<head>', '<head><base href="https://dagoldol.test/">', 1)
    css = "\n".join((ROOT / name).read_text(encoding="utf-8") for name in (
        "style.css", "pill-buttons.css", "phase2-fixes.css", "phase3-fixes.css"
    ))
    config_js = (ROOT / "config.js").read_text(encoding="utf-8")
    config_js = config_js.replace('PHASE2_ENABLED: true', 'PHASE2_ENABLED: false').replace('PHASE3_ENABLED: true', 'PHASE3_ENABLED: false')
    auth_js = (ROOT / "auth-resilience.js").read_text(encoding="utf-8")
    app_js = (ROOT / "script.js").read_text(encoding="utf-8")

    failures = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            executable_path="/usr/bin/chromium",
            args=["--no-sandbox"],
        )
        context = await browser.new_context(
            viewport={"width": 390, "height": 844},
            is_mobile=True,
            has_touch=True,
            device_scale_factor=3,
        )
        page = await context.new_page()
        page_errors = []
        console_messages = []
        page.on("pageerror", lambda exc: page_errors.append(str(exc)))
        page.on("console", lambda msg: console_messages.append(f"{msg.type}: {msg.text}"))

        async def snapshot_route(route):
            await route.fulfill(
                status=200,
                content_type="application/json",
                headers={"Access-Control-Allow-Origin": "*"},
                body=json.dumps(SNAPSHOT),
            )

        await page.route("https://dagoldol.test/catalogue-snapshot.json", snapshot_route)
        await page.route("https://dagoldol.test/product-routes.json", lambda route: route.fulfill(status=200, content_type="application/json", headers={"Access-Control-Allow-Origin":"*"}, body="{}"))
        await page.set_content(index_html, wait_until="domcontentloaded")
        await page.add_style_tag(content=css)
        await page.evaluate("history.replaceState = () => {}; history.pushState = () => {};")
        await page.add_script_tag(content=MOCK_SUPABASE_CDN)
        await page.add_script_tag(content=config_js)
        await page.add_script_tag(content=auth_js)
        await page.add_script_tag(content=app_js)
        await page.wait_for_timeout(1000)

        cards = await page.locator("#catalogue .product-card").count()
        if cards != 3:
            failures.append(f"snapshot fallback: expected 3 product cards after live product failure, got {cards}; console={console_messages}; html={await page.locator('#catalogue').inner_html()}")

        empty_text = await page.locator("#catalogue").inner_text()
        if "Nothing here yet" in empty_text:
            failures.append("snapshot fallback: app still shows the false empty-catalogue state")

        visible_logo_count = await page.locator("#shop-screen .brand-logo-img:not(.hidden)").count()
        if visible_logo_count != 1:
            failures.append(f"settings fallback: expected the snapshot shop logo to be visible, got {visible_logo_count}")

        positions = await page.evaluate("""() => {
          const rect = (selector) => {
            const el = document.querySelector(selector);
            const r = el.getBoundingClientRect();
            return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height};
          };
          return {
            brand: rect('#shop-screen .brand-mark'),
            cart: rect('#cart-btn'),
            account: rect('#account-menu-toggle'),
            search: rect('#catalogue-search'),
            docWidth: document.documentElement.scrollWidth,
            innerWidth: window.innerWidth
          };
        }""")
        top_values = [positions["brand"]["top"], positions["cart"]["top"], positions["account"]["top"]]
        if max(top_values) - min(top_values) > 14:
            failures.append(f"mobile header: brand/cart/account are not on one row: {top_values}")
        if positions["search"]["top"] <= max(positions["brand"]["bottom"], positions["cart"]["bottom"], positions["account"]["bottom"]):
            failures.append("mobile header: search field does not sit cleanly below the top action row")
        if positions["docWidth"] - positions["innerWidth"] > 1:
            failures.append(f"mobile fit: horizontal overflow {positions['docWidth'] - positions['innerWidth']}px")

        if cards:
            await page.locator("#account-menu-toggle").click()
            if await page.locator("#account-menu").evaluate("el => el.classList.contains('hidden')"):
                failures.append("interaction regression: Account menu did not open")
            else:
                await page.locator("#menu-login-btn").click()
                if await page.locator("#login-screen").evaluate("el => el.classList.contains('hidden')"):
                    failures.append("interaction regression: Login screen did not open from Account")
                else:
                    await page.locator("#login-back-btn").click()

            await page.locator("#cart-btn").click()
            if await page.locator("#cart-modal").evaluate("el => el.classList.contains('hidden')"):
                failures.append("interaction regression: Cart did not open")
            await page.locator("#cart-modal-close").click()

            await page.locator("#catalogue [data-action='cart']").first.click()
            if await page.locator("#size-modal").evaluate("el => el.classList.contains('hidden')"):
                failures.append("interaction regression: product size selector did not open")

        if page_errors:
            failures.append(f"page errors: {page_errors}")

        await context.close()
        await browser.close()

    if failures:
        raise SystemExit("\n".join(failures))
    print("mobile-resilience: PASS")

if __name__ == "__main__":
    asyncio.run(run_test())
