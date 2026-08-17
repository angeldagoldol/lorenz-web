import asyncio
import hashlib
import re
from pathlib import Path
from playwright.async_api import async_playwright

FIXED = Path(__file__).resolve().parents[1]
BASELINE = Path('/mnt/data/DAGOLDOL-PASTED-TEXT1-MOBILE-FIX')

MOCK = r'''
(() => {
  const IMG='data:image/svg+xml;charset=UTF-8,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 260"><rect width="400" height="260" fill="#171a23"/><circle cx="200" cy="130" r="80" fill="#4fe3c1" opacity=".45"/></svg>');
  const tables={
    settings:[{key:'shop_logo_image',value:IMG}],
    products:[
      {id:'p1',name:'Benguet Pine',description:'Test product one',accent:'#4fe3c1',icon:'',brand_id:null,unit_type:'feet',sizes:[{feet:2,price:20,stock:12,image:IMG}]},
      {id:'p2',name:'Durian Tree',description:'Test product two',accent:'#ff8a5b',icon:'',brand_id:null,unit_type:'feet',sizes:[{feet:8,price:600,stock:7,image:IMG}]},
      {id:'p3',name:'Norfolk Pine Tree',description:'Test product three',accent:'#626b80',icon:'',brand_id:null,unit_type:'feet',sizes:[{feet:4,price:199,stock:4,image:IMG}]}
    ],ratings:[],brands:[],flash_sales:[],bundles:[],promo_codes:[],orders:[],profiles:[],dm_threads:[],dm_messages:[],activity:[],messages:[]
  };
  class Query{constructor(t){this.t=t;this.filters=[];}select(){return this;}order(){return this;}eq(k,v){this.filters.push([k,v]);return this;}neq(){return this;}ilike(){return this;}or(){return this;}range(){return this;}limit(){return this;}insert(){return Promise.resolve({data:null,error:null});}update(){return this;}upsert(){return Promise.resolve({data:null,error:null});}delete(){return this;}maybeSingle(){return Promise.resolve({data:null,error:null});}single(){return Promise.resolve({data:null,error:{message:'not found'}});}rows(){return [...(tables[this.t]||[])];}then(r,j){return Promise.resolve({data:this.rows(),error:null}).then(r,j);}}
  const channel={on(){return this;},subscribe(cb){if(cb)setTimeout(()=>cb('SUBSCRIBED'),0);return this;},track(){return Promise.resolve();},presenceState(){return {};}};
  const client={auth:{async getSession(){return {data:{session:null},error:null};},onAuthStateChange(){return {data:{subscription:{unsubscribe(){}}}};},async signOut(){return {error:null};}},from(t){return new Query(t);},async rpc(n){if(n==='get_public_recommendation_signals')return {data:{trending:{},cooccurrence:{}},error:null};return {data:null,error:null};},channel(){return Object.create(channel);},removeChannel(){},storage:{from(){return {getPublicUrl(){return {data:{publicUrl:IMG}};}}}}};
  window.supabase={createClient(){return client;}};
})();
'''

def prepared(root: Path):
    html=(root/'index.html').read_text(encoding='utf-8')
    html=re.sub(r'<script\b[^>]*src="[^"]+"[^>]*></script>','',html,flags=re.I)
    html=re.sub(r'<link\b[^>]*rel="stylesheet"[^>]*>','',html,flags=re.I)
    html=re.sub(r'<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?>','',html,count=1,flags=re.I)
    css='\n'.join((root/name).read_text(encoding='utf-8') for name in ['style.css','pill-buttons.css','phase2-fixes.css','phase3-fixes.css'])
    config=(root/'config.js').read_text(encoding='utf-8').replace('PHASE2_ENABLED: true','PHASE2_ENABLED: false').replace('PHASE3_ENABLED: true','PHASE3_ENABLED: false')
    auth_path=root/'auth-resilience.js'
    auth=auth_path.read_text(encoding='utf-8') if auth_path.exists() else ''
    app=(root/'script.js').read_text(encoding='utf-8')
    return html,css,config,auth,app

async def render(page, root):
    html,css,config,auth,app=prepared(root)
    await page.set_content(html,wait_until='domcontentloaded')
    await page.add_style_tag(content=css)
    await page.evaluate('history.replaceState=()=>{};history.pushState=()=>{};')
    await page.add_script_tag(content=MOCK)
    await page.add_script_tag(content=config)
    if auth:
      await page.add_script_tag(content=auth)
    await page.add_script_tag(content=app)
    await page.wait_for_timeout(900)
    return await page.screenshot(full_page=True)

async def main():
    async with async_playwright() as p:
      browser=await p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
      c1=await browser.new_context(viewport={'width':1440,'height':900},device_scale_factor=1)
      c2=await browser.new_context(viewport={'width':1440,'height':900},device_scale_factor=1)
      p1=await c1.new_page();p2=await c2.new_page()
      before=await render(p1,BASELINE); after=await render(p2,FIXED)
      await c1.close();await c2.close();await browser.close()
    hb=hashlib.sha256(before).hexdigest(); ha=hashlib.sha256(after).hexdigest()
    if hb!=ha:
      Path('/mnt/data/desktop-before.png').write_bytes(before)
      Path('/mnt/data/desktop-after.png').write_bytes(after)
      raise SystemExit(f'desktop screenshot changed: before={hb} after={ha}')
    print(f'desktop-regression: PASS (1440px screenshot byte-identical {ha[:16]}...)')

if __name__=='__main__': asyncio.run(main())
