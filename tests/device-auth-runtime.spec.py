import asyncio
import json
import re
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]

HTML = (ROOT / 'index.html').read_text(encoding='utf-8')
HTML = re.sub(r'<script\b[^>]*src="[^"]+"[^>]*></script>', '', HTML, flags=re.I)
HTML = re.sub(r'<link\b[^>]*rel="stylesheet"[^>]*>', '', HTML, flags=re.I)
HTML = re.sub(r'<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?>', '', HTML, count=1, flags=re.I)
CSS = '\n'.join((ROOT / name).read_text(encoding='utf-8') for name in ['style.css','pill-buttons.css','phase2-fixes.css','phase3-fixes.css'])
CONFIG = (ROOT / 'config.js').read_text(encoding='utf-8').replace('PHASE2_ENABLED: true','PHASE2_ENABLED: false').replace('PHASE3_ENABLED: true','PHASE3_ENABLED: false')
AUTH = (ROOT / 'auth-resilience.js').read_text(encoding='utf-8')
APP = (ROOT / 'script.js').read_text(encoding='utf-8')
SNAPSHOT = json.dumps({"version":1,"products":[],"brands":[],"ratings":[],"flashSales":[],"settings":[]})

MOCK = r'''
(() => {
  class Query {
    constructor(table){ this.table=table; this.mode='select'; }
    select(){ return this; } order(){ return this; } eq(){ return this; } neq(){ return this; }
    ilike(){ return this; } or(){ return this; } range(){ return this; } limit(){ return this; }
    update(){ this.mode='update'; return this; } delete(){ this.mode='delete'; return this; }
    insert(){ return Promise.resolve({data:null,error:null}); }
    upsert(){ return Promise.resolve({data:null,error:null}); }
    maybeSingle(){ return Promise.resolve({data:null,error:null}); }
    single(){
      if (this.table === 'profiles') return Promise.resolve({data:{id:'u1',username:'tester',role:'customer',address:null,profile:{},cart:[]},error:null});
      return Promise.resolve({data:null,error:null});
    }
    then(resolve,reject){
      const data = this.table === 'settings' ? [] : [];
      return Promise.resolve({data,error:null}).then(resolve,reject);
    }
  }
  const channel={on(){return this;},subscribe(cb){if(cb)setTimeout(()=>cb('SUBSCRIBED'),0);return this;},track(){return Promise.resolve();},presenceState(){return {};}};
  window.supabase={
    createClient(url,key,options){
      const transport=options.global.fetch;
      return {
        auth:{
          async getSession(){return {data:{session:null},error:null};},
          onAuthStateChange(){return {data:{subscription:{unsubscribe(){}}}};},
          async signOut(){return {error:null};},
          async signInWithPassword(){
            const response=await transport(url+'/auth/v1/token?grant_type=password',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
            if(!response.ok) return {data:{user:null},error:{name:'AuthRetryableFetchError',message:'Load failed',status:0}};
            return {data:{user:{id:'u1'}},error:null};
          },
          async signUp(){
            const response=await transport(url+'/auth/v1/signup',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
            if(!response.ok) return {data:{user:null},error:{name:'AuthRetryableFetchError',message:'Load failed',status:0}};
            return {data:{user:{id:'u2'}},error:null};
          },
          async resetPasswordForEmail(){return {data:{},error:null};},
          async updateUser(){return {data:{},error:null};}
        },
        from(table){return new Query(table);},
        async rpc(name){if(name==='get_public_recommendation_signals')return {data:{trending:{},cooccurrence:{}},error:null};return {data:null,error:null};},
        channel(){return Object.create(channel);}, removeChannel(){},
        storage:{from(){return {async upload(){return {error:null};},getPublicUrl(){return {data:{publicUrl:''}};},async createSignedUrl(){return {data:{signedUrl:''},error:null};},async remove(){return {error:null};}};}},
        functions:{async invoke(){return {data:{ok:true},error:null};}}
      };
    }
  };
})();
'''

async def boot(page):
    await page.set_content(HTML, wait_until='domcontentloaded')
    await page.add_style_tag(content=CSS)
    await page.evaluate('history.replaceState=()=>{};history.pushState=()=>{};')
    await page.evaluate(f'''() => {{
      window.__dagoldolFetches=[];
      const snapshot={SNAPSHOT!r};
      window.fetch=async (input,init) => {{
        const url=String(input);
        window.__dagoldolFetches.push(url);
        if(url.startsWith('https://rvrjkfbenramappteuae.supabase.co/')) throw new TypeError('Load failed');
        if(url.startsWith('/api/supabase/')) return new Response('{{}}',{{status:200,headers:{{'Content-Type':'application/json'}}}});
        if(url.includes('catalogue-snapshot.json')) return new Response(snapshot,{{status:200,headers:{{'Content-Type':'application/json'}}}});
        if(url.includes('product-routes.json')) return new Response('{{}}',{{status:200,headers:{{'Content-Type':'application/json'}}}});
        return new Response('{{}}',{{status:200,headers:{{'Content-Type':'application/json'}}}});
      }};
    }}''')
    await page.add_script_tag(content=MOCK)
    await page.add_script_tag(content=CONFIG)
    await page.add_script_tag(content=AUTH)
    await page.add_script_tag(content=APP)
    await page.wait_for_timeout(350)

async def open_login(page):
    await page.locator('#account-menu-toggle').click()
    await page.locator('#menu-login-btn').click()
    await page.wait_for_timeout(50)

async def main():
    failures=[]
    async with async_playwright() as p:
        browser=await p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
        for width,height in [(320,700),(390,844),(430,932),(1280,900)]:
            context=await browser.new_context(viewport={'width':width,'height':height},is_mobile=width<=430,has_touch=width<=430,device_scale_factor=2 if width<=430 else 1)
            page=await context.new_page(); errors=[]
            page.on('pageerror',lambda exc,errors=errors: errors.append(str(exc)))
            await boot(page)
            await open_login(page)
            bounds=await page.locator('#login-card').bounding_box()
            if not bounds or bounds['x'] < -1 or bounds['x']+bounds['width'] > width+1:
                failures.append(f'{width}px login card outside viewport: {bounds}')
            skip=await page.locator('#skip-to-content').bounding_box()
            if skip and skip['y'] + skip['height'] > 0:
                failures.append(f'{width}px skip link visible without keyboard focus: {skip}')
            await page.locator('#login-email').fill('test@example.com')
            await page.locator('#password').fill('not-a-real-password')
            await page.locator('#login-form button[type="submit"]').click()
            await page.wait_for_timeout(150)
            label=await page.locator('#account-menu-label').inner_text()
            if label != 'tester': failures.append(f'{width}px resilient login did not enter customer state: {label}')
            fetches=await page.evaluate('window.__dagoldolFetches')
            if not any('/api/supabase/auth/v1/token?grant_type=password' in x for x in fetches):
                failures.append(f'{width}px auth proxy fallback not used: {fetches}')
            if errors: failures.append(f'{width}px page errors: {errors}')
            await context.close()
        await browser.close()
    if failures: raise SystemExit('\n'.join(failures))
    print('device-auth-runtime: PASS (320/390/430/1280; login fits, skip hidden, direct Supabase failure falls back, customer session enters)')

if __name__=='__main__': asyncio.run(main())
