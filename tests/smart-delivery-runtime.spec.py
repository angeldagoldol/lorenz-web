import asyncio
import json
import re
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT/'index.html').read_text(encoding='utf-8')
HTML = re.sub(r'<script\b[^>]*src="[^"]+"[^>]*></script>', '', HTML, flags=re.I)
HTML = re.sub(r'<link\b[^>]*rel="stylesheet"[^>]*>', '', HTML, flags=re.I)
HTML = re.sub(r'<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?>', '', HTML, count=1, flags=re.I)
HTML = HTML.replace('<head>', '<head><base href="https://dagoldol.test/">', 1)
CSS = '\n'.join((ROOT/name).read_text(encoding='utf-8') for name in ['style.css','pill-buttons.css','phase2-fixes.css','phase3-fixes.css'])
CONFIG = (ROOT/'config.js').read_text(encoding='utf-8').replace('PHASE2_ENABLED: true','PHASE2_ENABLED: false').replace('PHASE3_ENABLED: true','PHASE3_ENABLED: false')
AUTH = (ROOT/'auth-resilience.js').read_text(encoding='utf-8')
APP = (ROOT/'script.js').read_text(encoding='utf-8')
MAP_MODULE = (ROOT/'delivery-map.js').read_text(encoding='utf-8')
SNAPSHOT = json.dumps({"version":1,"products":[],"brands":[],"ratings":[],"flashSales":[],"settings":[]})

FAKE_LEAFLET = r'''
(() => {
  class Map { constructor(container,options){this.handlers={};window.__fakeMap=this;} setView(){return this;} on(n,cb){this.handlers[n]=cb;return this;} invalidateSize(){return this;} remove(){} }
  class Tile { on(){return this;} addTo(){return this;} remove(){} }
  class Marker { constructor(latlng,options){this.latlng={lat:latlng[0],lng:latlng[1]};this.handlers={};window.__fakeMarkerOptions=options;} setLatLng(v){this.latlng=Array.isArray(v)?{lat:v[0],lng:v[1]}:v;return this;} addTo(){return this;} getLatLng(){return this.latlng;} on(n,cb){this.handlers[n]=cb;return this;} remove(){} }
  class Circle { addTo(){return this;} remove(){} }
  window.L={map:(c,o)=>new Map(c,o),tileLayer:()=>new Tile(),divIcon:o=>o,marker:(l,o)=>new Marker(l,o),circle:()=>new Circle()};
})();
'''

CUSTOMER = {
  "id":"cust1","username":"customer1","role":"customer","profile":{"name":"Juan Customer","email":"juan@example.com","phone":"09170000001"},"cart":[],
  "address":{"address":"Old Road","city":"Davao City","postal":"8000","landmark":"Blue gate","location":{"latitude":7.0731,"longitude":125.6128,"source":"pin","pinned_at":"2026-08-18T00:00:00.000Z","address_snapshot":{"address":"Old Road","city":"Davao City","postal":"8000"}}}
}
CUSTOMER2 = {"id":"cust2","username":"customer2","role":"customer","profile":{"name":"Order Pin Customer"},"cart":[],"address":{"address":"Typed only","city":"Davao City","postal":"8000","landmark":""}}
ADMIN = {"id":"admin1","username":"owner","role":"admin","profile":{"name":"Owner"},"address":None,"cart":[]}
ORDER2 = {"user_id":"cust2","placed_at":1787000000000,"address":{"address":"Latest Order Road","city":"Davao City","postal":"8000","landmark":"Red gate","location":{"latitude":7.1101,"longitude":125.6202,"source":"pin","address_snapshot":{"address":"Latest Order Road","city":"Davao City","postal":"8000"}}}}

def mock_client(role='customer'):
    current = CUSTOMER if role == 'customer' else ADMIN
    customers = [CUSTOMER, CUSTOMER2]
    orders = [ORDER2]
    return f'''
(() => {{
  const current={json.dumps(current)}; const customers={json.dumps(customers)}; const orders={json.dumps(orders)};
  class Query {{
    constructor(table){{this.table=table;this.filters=[];this.columns="*";}}
    select(cols="*"){{this.columns=cols;return this;}} order(){{return this;}} neq(){{return this;}} ilike(){{return this;}} or(){{return this;}} range(){{return this;}} limit(){{return this;}}
    eq(k,v){{this.filters.push([k,v]);return this;}} update(){{return this;}} delete(){{return this;}}
    insert(){{return Promise.resolve({{data:null,error:null}});}} upsert(){{return Promise.resolve({{data:null,error:null}});}}
    maybeSingle(){{return Promise.resolve({{data:null,error:null}});}}
    single(){{ if(this.table==='profiles') return Promise.resolve({{data:current,error:null}}); return Promise.resolve({{data:null,error:null}}); }}
    then(resolve,reject){{
      let result={{data:[],error:null}};
      if(this.table==='profiles') {{
        const roleFilter=this.filters.find(x=>x[0]==='role');
        result={{data:roleFilter && roleFilter[1]==='customer' ? customers : [],error:null}};
      }} else if(this.table==='orders') result={{data:(String(this.columns).includes('user_id') && String(this.columns).includes('address') ? orders : []),error:null}};
      else if(this.table==='products' || this.table==='settings') result={{data:null,error:{{message:'fixture uses snapshot'}}}};
      return Promise.resolve(result).then(resolve,reject);
    }}
  }}
  const channel={{on(){{return this;}},subscribe(cb){{if(cb)setTimeout(()=>cb('SUBSCRIBED'),0);return this;}},track(){{return Promise.resolve();}},presenceState(){{return {{}};}}}};
  const client={{auth:{{async getSession(){{return {{data:{{session:{{user:{{id:current.id}}}}}},error:null}};}},onAuthStateChange(){{return {{data:{{subscription:{{unsubscribe(){{}}}}}}}};}},async signOut(){{return {{error:null}};}}}},from(t){{return new Query(t);}},async rpc(name){{if(name==='get_public_recommendation_signals')return {{data:{{trending:{{}},cooccurrence:{{}}}},error:null}};return {{data:null,error:null}};}},channel(){{return Object.create(channel);}},removeChannel(){{}},storage:{{from(){{return {{async upload(){{return {{error:null}};}},getPublicUrl(){{return {{data:{{publicUrl:''}}}};}},async createSignedUrl(){{return {{data:{{signedUrl:''}},error:null}};}},async remove(){{return {{error:null}};}}}};}}}},functions:{{async invoke(){{return {{data:{{ok:true}},error:null}};}}}}}};
  window.supabase={{createClient(){{return client;}}}};
}})();
'''

async def common_routes(page, delayed_reverse=False):
    await page.route('https://dagoldol.test/delivery-map.js*', lambda r: r.fulfill(status=200, content_type='application/javascript', body=MAP_MODULE))
    for url in ['https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js','https://unpkg.com/leaflet@1.9.4/dist/leaflet.js']:
        await page.route(url, lambda r: r.fulfill(status=200, content_type='application/javascript', body=FAKE_LEAFLET))
    for url in ['https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css','https://unpkg.com/leaflet@1.9.4/dist/leaflet.css']:
        await page.route(url, lambda r: r.fulfill(status=200, content_type='text/css', body=''))
    async def nominatim(route):
        if delayed_reverse: await asyncio.sleep(0.55)
        body=json.dumps({"display_name":"Purok 5, Barangay Tamugan, Baguio District, Davao City, Davao Region, 8000, Philippines","address":{"postcode":"8000","country_code":"ph"}})
        await route.fulfill(status=200, content_type='application/json', body=body)
    await page.route('https://nominatim.openstreetmap.org/**', nominatim)
    await page.route('https://dagoldol.test/catalogue-snapshot.json*', lambda r: r.fulfill(status=200, content_type='application/json', body=SNAPSHOT))
    await page.route('https://dagoldol.test/product-routes.json*', lambda r: r.fulfill(status=200, content_type='application/json', body='{}'))
    await page.route('https://router.project-osrm.org/**', lambda r: r.fulfill(status=200, content_type='application/json', body='{"routes":[{"distance":4000}]}'))

async def boot(page, role='customer', delayed_reverse=False):
    await common_routes(page, delayed_reverse)
    await page.set_content(HTML, wait_until='domcontentloaded')
    await page.add_style_tag(content=CSS)
    await page.evaluate('history.replaceState=()=>{};history.pushState=()=>{};')
    await page.add_script_tag(content=mock_client(role))
    await page.add_script_tag(content=CONFIG)
    await page.add_script_tag(content=AUTH)
    await page.add_script_tag(content=APP)
    await page.wait_for_timeout(500)

async def main():
    failures=[]
    async with async_playwright() as p:
        browser=await p.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        # Customer: confirm must wait for delayed reverse lookup, then complete sparse PH address.
        ctx=await browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
        page=await ctx.new_page(); errors=[]; page.on('pageerror',lambda e: errors.append(str(e)))
        await boot(page,'customer',True)
        await page.locator('#account-menu-toggle').click(); await page.locator('#profile-btn').click(); await page.locator('#profile-location-open').click(); await page.wait_for_timeout(100)
        await page.evaluate("window.__fakeMap.handlers.click({latlng:{lng:125.6128,lat:7.0731}})")
        await page.wait_for_timeout(100)
        if not await page.locator('#delivery-map-confirm').is_disabled(): failures.append('confirm enabled before reverse lookup completed')
        if 'Finding address' not in await page.locator('#delivery-map-confirm').inner_text(): failures.append('confirm did not show Finding address state')
        await page.wait_for_timeout(1500)
        if await page.locator('#delivery-map-confirm').is_disabled(): failures.append('confirm stayed disabled after reverse lookup')
        await page.locator('#delivery-map-confirm').click(); await page.wait_for_timeout(80)
        if await page.locator('#profile-address').input_value()!='Purok 5, Barangay Tamugan': failures.append('sparse reverse result did not recover street')
        if await page.locator('#profile-city').input_value()!='Davao City': failures.append('sparse reverse result did not recover city')
        if await page.locator('#profile-landmark').input_value()!='Blue gate': failures.append('manual landmark was overwritten')
        if errors: failures.append(f'customer page errors: {errors}')
        await ctx.close()

        # Admin: all customer cards show delivery state; pins open read-only map.
        ctx=await browser.new_context(viewport={'width':1280,'height':900})
        page=await ctx.new_page(); errors=[]; page.on('pageerror',lambda e: errors.append(str(e)))
        await boot(page,'admin',False)
        await page.locator('[data-tab="accounts"]').click(); await page.wait_for_timeout(250)
        text=await page.locator('#admin-tab-accounts').inner_text()
        if 'Old Road, Davao City, 8000' not in text: failures.append('admin did not show profile delivery address')
        if 'Latest Order Road, Davao City, 8000' not in text: failures.append('admin did not fall back to latest order pin')
        if text.count('View delivery pin')<2: failures.append('admin did not expose view-pin action for both pinned customers')
        await page.locator('[data-action="view-customer-location"]').first.click(); await page.wait_for_timeout(180)
        if await page.locator('#delivery-map-modal').get_attribute('class') and 'hidden' in await page.locator('#delivery-map-modal').get_attribute('class'): failures.append('admin delivery map did not open')
        if not await page.locator('#delivery-map-confirm').is_hidden(): failures.append('admin read-only map exposed confirm action')
        if not await page.locator('#delivery-map-current-location').is_hidden(): failures.append('admin read-only map exposed current-location action')
        if await page.evaluate('window.__fakeMarkerOptions.draggable') is not False: failures.append('admin customer marker is draggable')
        if errors: failures.append(f'admin page errors: {errors}')
        await ctx.close(); await browser.close()
    if failures: raise SystemExit('\n'.join(failures))
    print('smart-delivery-runtime: PASS (delayed geocode gate, sparse PH address recovery, manual landmark preservation, admin profile/latest-order pin visibility, read-only map)')

if __name__=='__main__': asyncio.run(main())
