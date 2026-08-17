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

PROFILE = {
    "id":"u1",
    "username":"tester",
    "role":"customer",
    "profile":{"name":"Test Customer","email":"test@example.com","phone":"09170000000","bio":""},
    "address":{
        "name":"Test Customer","phone":"09170000000","address":"Old Road","city":"Davao City","postal":"8000","landmark":"Blue gate",
        "location":{"latitude":7.0731,"longitude":125.6128,"source":"pin","pinned_at":"2026-08-18T00:00:00.000Z","address_snapshot":{"address":"Old Road","city":"Davao City","postal":"8000"}}
    },
    "cart":[]
}

MOCK = f'''
(() => {{
  const profile={json.dumps(PROFILE)};
  window.__profileUpdates=[];
  class Query {{
    constructor(table){{this.table=table;this.payload=null;}}
    select(){{return this;}} order(){{return this;}} eq(){{return this;}} neq(){{return this;}}
    ilike(){{return this;}} or(){{return this;}} range(){{return this;}} limit(){{return this;}}
    update(payload){{this.payload=payload; if(this.table==='profiles') window.__profileUpdates.push(payload); return this;}}
    delete(){{return this;}}
    insert(){{return Promise.resolve({{data:null,error:null}});}}
    upsert(){{return Promise.resolve({{data:null,error:null}});}}
    maybeSingle(){{return Promise.resolve({{data:null,error:null}});}}
    single(){{
      if(this.table==='profiles') return Promise.resolve({{data:profile,error:null}});
      return Promise.resolve({{data:null,error:null}});
    }}
    then(resolve,reject){{
      const result = this.table==='products' || this.table==='settings'
        ? {{data:null,error:{{message:'fixture uses snapshot'}}}}
        : {{data:[],error:null}};
      return Promise.resolve(result).then(resolve,reject);
    }}
  }}
  const channel={{on(){{return this;}},subscribe(cb){{if(cb)setTimeout(()=>cb('SUBSCRIBED'),0);return this;}},track(){{return Promise.resolve();}},presenceState(){{return {{}};}}}};
  const client={{
    auth:{{
      async getSession(){{return {{data:{{session:{{user:{{id:'u1'}}}}}},error:null}};}},
      onAuthStateChange(){{return {{data:{{subscription:{{unsubscribe(){{}}}}}}}};}},
      async signOut(){{return {{error:null}};}}, async signInWithPassword(){{return {{data:{{user:{{id:'u1'}}}},error:null}};}},
      async signUp(){{return {{data:{{user:{{id:'u2'}}}},error:null}};}}, async resetPasswordForEmail(){{return {{data:{{}},error:null}};}}, async updateUser(){{return {{data:{{}},error:null}};}}
    }},
    from(table){{return new Query(table);}},
    async rpc(name){{if(name==='get_public_recommendation_signals')return {{data:{{trending:{{}},cooccurrence:{{}}}},error:null}};return {{data:null,error:null}};}},
    channel(){{return Object.create(channel);}}, removeChannel(){{}},
    storage:{{from(){{return {{async upload(){{return {{error:null}};}},getPublicUrl(){{return {{data:{{publicUrl:''}}}};}},async createSignedUrl(){{return {{data:{{signedUrl:''}},error:null}};}},async remove(){{return {{error:null}};}}}};}}}},
    functions:{{async invoke(){{return {{data:{{ok:true}},error:null}};}}}}
  }};
  window.supabase={{createClient(){{return client;}}}};
}})();
'''

FAKE_LEAFLET = r'''
(() => {
  class Map {
    constructor(container, options){ this.container=container; this.options=options; this.handlers={}; window.__fakeMap=this; }
    setView(latlng, zoom){ this.center=latlng; this.zoom=zoom; return this; }
    on(name,cb){ this.handlers[name]=cb; return this; }
    invalidateSize(){ this.invalidated=true; return this; }
    remove(){}
  }
  class TileLayer {
    constructor(){ this.handlers={}; }
    on(name,cb){ this.handlers[name]=cb; return this; }
    addTo(map){ this.map=map; return this; }
    remove(){}
  }
  class Marker {
    constructor(latlng){ this.latlng={lat:latlng[0],lng:latlng[1]}; this.handlers={}; this.added=false; }
    setLatLng(value){ this.latlng=Array.isArray(value)?{lat:value[0],lng:value[1]}:value; return this; }
    addTo(){ this.added=true; return this; }
    getLatLng(){ return this.latlng; }
    on(name,cb){ this.handlers[name]=cb; return this; }
    remove(){ this.added=false; }
  }
  class Circle { addTo(){ return this; } remove(){} }
  window.L={
    map(container,options){ return new Map(container,options); },
    tileLayer(){ return new TileLayer(); },
    divIcon(options){ return options; },
    marker(latlng){ return new Marker(latlng); },
    circle(){ return new Circle(); }
  };
})();
'''

async def boot(page):
    await page.route('https://dagoldol.test/delivery-map.js*', lambda route: route.fulfill(status=200, content_type='application/javascript', body=MAP_MODULE))
    await page.route('https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js', lambda route: route.fulfill(status=200, content_type='application/javascript', body=FAKE_LEAFLET))
    await page.route('https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css', lambda route: route.fulfill(status=200, content_type='text/css', body=''))
    await page.route('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', lambda route: route.fulfill(status=200, content_type='application/javascript', body=FAKE_LEAFLET))
    await page.route('https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', lambda route: route.fulfill(status=200, content_type='text/css', body=''))
    async def nominatim(route):
        url=route.request.url
        if '/reverse' in url:
            body=json.dumps({"display_name":"123 New Road, Barangay 1, Davao City, 8000, Philippines","address":{"house_number":"123","road":"New Road","neighbourhood":"Barangay 1","city":"Davao City","postcode":"8000","country_code":"ph"}})
        else:
            body=json.dumps([{"lat":"7.2777","lon":"125.3245"}])
        await route.fulfill(status=200, content_type='application/json', body=body)
    await page.route('https://nominatim.openstreetmap.org/**', nominatim)
    await page.route('https://router.project-osrm.org/**', lambda route: route.fulfill(status=200, content_type='application/json', body='{"routes":[{"distance":4000}]}'))
    await page.route('https://dagoldol.test/catalogue-snapshot.json*', lambda route: route.fulfill(status=200, content_type='application/json', body=SNAPSHOT))
    await page.route('https://dagoldol.test/product-routes.json*', lambda route: route.fulfill(status=200, content_type='application/json', body='{}'))
    await page.set_content(HTML, wait_until='domcontentloaded')
    await page.evaluate("""() => {
      const geo = {
        watchPosition(success) { setTimeout(() => success({coords:{latitude:7.0731,longitude:125.6128,accuracy:24},timestamp:Date.now()}), 5); return 91; },
        getCurrentPosition(success) { setTimeout(() => success({coords:{latitude:7.0732,longitude:125.6129,accuracy:180},timestamp:Date.now()}), 8); },
        clearWatch() {}
      };
      Object.defineProperty(navigator, 'geolocation', { configurable:true, value:geo });
      if (navigator.permissions && navigator.permissions.query) {
        navigator.permissions.query = async ({name}) => name === 'geolocation' ? {state:'granted'} : {state:'prompt'};
      }
    }""")
    await page.add_style_tag(content=CSS)
    await page.evaluate('history.replaceState=()=>{};history.pushState=()=>{};')
    await page.add_script_tag(content=MOCK)
    await page.add_script_tag(content=CONFIG)
    await page.add_script_tag(content=AUTH)
    await page.add_script_tag(content=APP)
    await page.wait_for_timeout(500)

async def main():
    failures=[]
    async with async_playwright() as p:
      browser=await p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
      for width,height in [(320,700),(390,844),(430,932),(1440,900)]:
        context=await browser.new_context(viewport={'width':width,'height':height},is_mobile=width<=430,has_touch=width<=430)
        page=await context.new_page(); errors=[]
        page.on('pageerror',lambda exc,errors=errors: errors.append(str(exc)))
        await boot(page)
        await page.evaluate("document.querySelector('#global-error-banner')?.classList.add('hidden')")
        # Profile restores account-synced map location.
        await page.locator('#account-menu-toggle').click(); await page.locator('#profile-btn').click(); await page.wait_for_timeout(60)
        state=await page.locator('#profile-location-current').get_attribute('data-state')
        if state!='saved': failures.append(f'{width}px profile pin not restored: {state}')
        if await page.locator('#profile-address').input_value()!='Old Road': failures.append(f'{width}px profile address not restored')
        # Current-location pin reverse geocodes and fills profile fields.
        await page.locator('#profile-location-open').click(); await page.wait_for_timeout(120)
        await page.locator('#delivery-map-current-location').click(); await page.wait_for_timeout(1400)
        current_summary=await page.locator('#delivery-map-summary').inner_text()
        if not current_summary: failures.append(f'{width}px current-location summary stayed empty')
        if await page.locator('#delivery-map-confirm').is_disabled(): failures.append(f'{width}px current-location did not enable confirm')
        await page.evaluate("window.__fakeMap.handlers.click({latlng:{lng:125.6128,lat:7.0731}})")
        await page.wait_for_timeout(1300)
        if await page.locator('#delivery-map-confirm').is_disabled(): failures.append(f'{width}px confirm stayed disabled')
        await page.locator('#delivery-map-confirm').click(); await page.wait_for_timeout(50)
        if await page.locator('#profile-address').input_value()!='123 New Road, Barangay 1': failures.append(f'{width}px reverse address did not fill profile')
        await page.locator('#profile-form button[type="submit"]').click(); await page.wait_for_timeout(60)
        updates=await page.evaluate('window.__profileUpdates')
        if not any((u.get('address') or {}).get('location',{}).get('latitude')==7.0731 for u in updates): failures.append(f'{width}px profile location not persisted')
        # Checkout map is usable independently and manual edit invalidates stale pin.
        await page.evaluate("document.querySelector('#profile-modal').classList.add('hidden'); document.querySelector('#shop-screen').classList.add('hidden'); document.querySelector('#checkout-screen').classList.remove('hidden');")
        await page.locator('#order-address').fill('Old Road'); await page.locator('#order-city').fill('Davao City'); await page.locator('#order-postal').fill('8000')
        await page.locator('#checkout-location-open').click(); await page.wait_for_timeout(120)
        await page.evaluate("window.__fakeMap.handlers.click({latlng:{lng:125.6128,lat:7.0731}})")
        await page.wait_for_timeout(1300)
        await page.locator('#delivery-map-confirm').click(); await page.wait_for_timeout(100)
        delivery_text=await page.locator('#delivery-distance-status').inner_text()
        if 'exact map pin' not in delivery_text: failures.append(f'{width}px delivery did not route by pin: {delivery_text}')
        await page.locator('#order-address').fill('Manually Edited Road'); await page.wait_for_timeout(20)
        stale=await page.locator('#checkout-location-current').get_attribute('data-state')
        if stale!='stale': failures.append(f'{width}px manual edit did not stale pin: {stale}')
        # No horizontal page overflow introduced.
        overflow=await page.evaluate('document.documentElement.scrollWidth-innerWidth')
        if overflow>1: failures.append(f'{width}px horizontal overflow: {overflow}')
        if errors: failures.append(f'{width}px page errors: {errors}')
        await context.close()
      await browser.close()
    if failures: raise SystemExit('\n'.join(failures))
    print('delivery-location-runtime: PASS (320/390/430/1440; Leaflet map, live current-location pin, profile restore/save, checkout direct-pin routing, stale-pin protection, no overflow)')

if __name__=='__main__': asyncio.run(main())
