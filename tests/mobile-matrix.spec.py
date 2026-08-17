import asyncio
import json
import re
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]

SNAPSHOT = {
    "version": 1,
    "generatedAt": "2026-08-16T00:00:00Z",
    "products": [
        {"id":"p1","name":"Benguet Pine","description":"One","accent":"#4fe3c1","icon":"","brand_id":None,"unit_type":"feet","sizes":[{"feet":2,"price":20,"stock":10,"image":"/tests/fixture-product.svg"}]},
        {"id":"p2","name":"Durian Tree","description":"Two","accent":"#ff8a5b","icon":"","brand_id":None,"unit_type":"feet","sizes":[{"feet":8,"price":600,"stock":10,"image":"/tests/fixture-product.svg"}]},
        {"id":"p3","name":"Norfolk Pine Tree","description":"Three","accent":"#626b80","icon":"","brand_id":None,"unit_type":"feet","sizes":[{"feet":4,"price":199,"stock":10,"image":"/tests/fixture-product.svg"}]}
    ],
    "brands": [], "ratings": [], "flashSales": [],
    "settings": [{"key":"shop_logo_image","value":"/tests/fixture-product.svg"}]
}

MOCK = r'''
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

async def main():
    index=(ROOT/'index.html').read_text(encoding='utf-8')
    index=re.sub(r'<script\b[^>]*src="[^"]+"[^>]*></script>','',index,flags=re.I)
    index=re.sub(r'<link\b[^>]*rel="stylesheet"[^>]*>','',index,flags=re.I)
    index=re.sub(r'<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?>','',index,count=1,flags=re.I)
    index=index.replace('<head>','<head><base href="https://dagoldol.test/">',1)
    css='\n'.join((ROOT/name).read_text(encoding='utf-8') for name in ['style.css','pill-buttons.css','phase2-fixes.css','phase3-fixes.css'])
    config=(ROOT/'config.js').read_text(encoding='utf-8').replace('PHASE2_ENABLED: true','PHASE2_ENABLED: false').replace('PHASE3_ENABLED: true','PHASE3_ENABLED: false')
    auth=(ROOT/'auth-resilience.js').read_text(encoding='utf-8')
    app=(ROOT/'script.js').read_text(encoding='utf-8')
    fixture=ROOT/'tests'/'fixture-product.svg'
    fixture.write_text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 260"><rect width="400" height="260" fill="#171a23"/><circle cx="200" cy="130" r="80" fill="#4fe3c1" opacity=".45"/></svg>',encoding='utf-8')
    failures=[]
    try:
      async with async_playwright() as p:
        browser=await p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
        for width,height in [(320,700),(360,780),(390,844),(414,896),(430,932)]:
          context=await browser.new_context(viewport={'width':width,'height':height},is_mobile=True,has_touch=True,device_scale_factor=3)
          page=await context.new_page(); errors=[]
          page.on('pageerror',lambda exc,errors=errors: errors.append(str(exc)))
          await page.route('https://dagoldol.test/catalogue-snapshot.json',lambda route: route.fulfill(status=200,content_type='application/json',headers={'Access-Control-Allow-Origin':'*'},body=json.dumps(SNAPSHOT)))
          await page.route('https://dagoldol.test/product-routes.json',lambda route: route.fulfill(status=200,content_type='application/json',headers={'Access-Control-Allow-Origin':'*'},body='{}'))
          await page.set_content(index,wait_until='domcontentloaded'); await page.add_style_tag(content=css)
          await page.evaluate('history.replaceState=()=>{};history.pushState=()=>{};')
          await page.add_script_tag(content=MOCK); await page.add_script_tag(content=config); await page.add_script_tag(content=auth); await page.add_script_tag(content=app)
          await page.wait_for_timeout(900)
          cards=await page.locator('#catalogue .product-card').count()
          if cards!=3: failures.append(f'{width}px: expected 3 cards, got {cards}')
          metrics=await page.evaluate('''() => {
            const r=s=>{const x=document.querySelector(s).getBoundingClientRect();return {top:x.top,bottom:x.bottom,left:x.left,right:x.right,width:x.width,height:x.height}};
            const filters=[...document.querySelectorAll('#shop-screen .header-filters select, #catalogue-filter-clear')].map(el=>{const x=el.getBoundingClientRect();return {left:x.left,right:x.right,top:x.top,bottom:x.bottom,width:x.width}});
            return {brand:r('#shop-screen .brand-mark'),cart:r('#cart-btn'),account:r('#account-menu-toggle'),search:r('#catalogue-search'),filters,sw:document.documentElement.scrollWidth,iw:innerWidth};
          }''')
          tops=[metrics['brand']['top'],metrics['cart']['top'],metrics['account']['top']]
          if max(tops)-min(tops)>16: failures.append(f'{width}px: top row misaligned {tops}')
          if metrics['search']['top'] <= max(metrics['brand']['bottom'],metrics['cart']['bottom'],metrics['account']['bottom']): failures.append(f'{width}px: search overlaps top row')
          if metrics['sw']-metrics['iw']>1: failures.append(f'{width}px: horizontal overflow {metrics["sw"]-metrics["iw"]}')
          for i,f in enumerate(metrics['filters']):
            if f['left'] < -1 or f['right'] > width+1: failures.append(f'{width}px: filter {i} outside viewport {f}')
          if errors: failures.append(f'{width}px: page errors {errors}')
          await context.close()
        await browser.close()
    finally:
      fixture.unlink(missing_ok=True)
    if failures: raise SystemExit('\n'.join(failures))
    print('mobile-matrix: PASS (320/360/390/414/430; snapshot products, logo fallback, aligned header, no overflow)')

if __name__=='__main__': asyncio.run(main())
