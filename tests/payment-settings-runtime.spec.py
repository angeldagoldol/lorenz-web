import asyncio
import re
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]

MOCK_SUPABASE = r'''
(() => {
  const IMG = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="white"/><rect x="10" y="10" width="30" height="30" fill="black"/><rect x="60" y="10" width="30" height="30" fill="black"/><rect x="10" y="60" width="30" height="30" fill="black"/></svg>');
  window.__settingsUpserts = [];
  const tables = {
    settings: [
      {key:'gcash_number', value:'0999 111 2222'},
      {key:'gcash_qr_image', value:IMG},
      {key:'bank_name', value:'Test Bank'},
      {key:'bank_account_name', value:'Dagoldol Owner'},
      {key:'bank_account_number', value:'1234 5678 9000'},
      {key:'bank_qr_image', value:IMG}
    ],
    products: [{
      id:'p1', name:'Test Product', description:'Test', accent:'#4fe3c1', icon:'', brand_id:null,
      unit_type:'feet', sizes:[{feet:2, price:49, stock:10, image:IMG}]
    }],
    ratings:[], brands:[], flash_sales:[], bundles:[], promo_codes:[], orders:[], profiles:[],
    dm_threads:[], dm_messages:[], activity:[], messages:[]
  };

  class Query {
    constructor(table){ this.table = table; this.filters = []; }
    select(){ return this; }
    order(){ return this; }
    eq(k,v){ this.filters.push([k,v]); return this; }
    neq(){ return this; }
    ilike(){ return this; }
    or(){ return this; }
    range(){ return this; }
    limit(){ return this; }
    insert(){ return Promise.resolve({data:null,error:null}); }
    update(){ return this; }
    delete(){ return this; }
    maybeSingle(){ return Promise.resolve({data:null,error:null}); }
    single(){ return Promise.resolve({data:null,error:{message:'not found'}}); }
    upsert(row){
      if (this.table === 'settings') window.__settingsUpserts.push(row);
      return Promise.resolve({data:row,error:null});
    }
    then(resolve,reject){
      return Promise.resolve({data:[...(tables[this.table] || [])],error:null}).then(resolve,reject);
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
      if (name === 'get_public_recommendation_signals') return {data:{trending:{},cooccurrence:{}},error:null};
      return {data:null,error:null};
    },
    channel(){ return Object.create(channel); },
    removeChannel(){},
    storage: {
      from(){
        return {
          async upload(){ return {error:null}; },
          getPublicUrl(){ return {data:{publicUrl:IMG}}; },
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


def prepared_source():
    html = (ROOT / 'index.html').read_text(encoding='utf-8')
    html = re.sub(r'<script\b[^>]*src="[^"]+"[^>]*></script>', '', html, flags=re.I)
    html = re.sub(r'<link\b[^>]*rel="stylesheet"[^>]*>', '', html, flags=re.I)
    html = re.sub(r'<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?>', '', html, count=1, flags=re.I)
    css = '\n'.join((ROOT / name).read_text(encoding='utf-8') for name in (
        'style.css', 'pill-buttons.css', 'phase2-fixes.css', 'phase3-fixes.css'
    ))
    config = (ROOT / 'config.js').read_text(encoding='utf-8')
    config = config.replace('PHASE2_ENABLED: true', 'PHASE2_ENABLED: false').replace('PHASE3_ENABLED: true', 'PHASE3_ENABLED: false')
    auth = (ROOT / 'auth-resilience.js').read_text(encoding='utf-8')
    app = (ROOT / 'script.js').read_text(encoding='utf-8')
    return html, css, config, auth, app


async def main():
    html, css, config, auth, app = prepared_source()
    failures = []

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        context = await browser.new_context(viewport={'width': 1280, 'height': 900})
        page = await context.new_page()
        page_errors = []
        page.on('pageerror', lambda exc: page_errors.append(str(exc)))

        await page.set_content(html, wait_until='domcontentloaded')
        await page.add_style_tag(content=css)
        await page.evaluate('history.replaceState=()=>{};history.pushState=()=>{};')
        await page.add_script_tag(content=MOCK_SUPABASE)
        await page.add_script_tag(content=config)
        await page.add_script_tag(content=auth)
        await page.add_script_tag(content=app)
        await page.wait_for_timeout(700)

        # Password toggle must remain positioned within the password wrapper.
        await page.evaluate("document.querySelector('#login-screen').classList.remove('hidden')")
        position = await page.locator("#login-screen .password-toggle-btn[data-target='password']").evaluate("el => getComputedStyle(el).position")
        if position != 'absolute':
            failures.append(f'password toggle position expected absolute, got {position}')
        geometry = await page.evaluate("""() => {
          const wrap = document.querySelector('#login-screen .password-input-wrap');
          const button = document.querySelector("#login-screen .password-toggle-btn[data-target='password']");
          const w = wrap.getBoundingClientRect();
          const b = button.getBoundingClientRect();
          return {wrapTop:w.top, wrapBottom:w.bottom, buttonTop:b.top, buttonBottom:b.bottom};
        }""")
        if geometry['buttonTop'] < geometry['wrapTop'] - 1 or geometry['buttonBottom'] > geometry['wrapBottom'] + 1:
            failures.append(f'password toggle escaped password field: {geometry}')
        await page.locator('#password').fill('secret12')
        await page.locator("#login-screen .password-toggle-btn[data-target='password']").click()
        pw_type = await page.locator('#password').get_attribute('type')
        if pw_type != 'text':
            failures.append(f'password Show button did not reveal password, type={pw_type}')

        # Customer bank panel should render persisted settings and QR.
        await page.evaluate("() => { const el = document.querySelector(\"input[name='payment-method'][value='bank']\"); el.checked = true; el.dispatchEvent(new Event('change', {bubbles:true})); }")
        if await page.locator('#payment-detail-bank').evaluate("el => el.classList.contains('hidden')"):
            failures.append('Bank Transfer detail panel stayed hidden')
        expected = {
            '#bank-name-text': 'Test Bank',
            '#bank-account-name-text': 'Dagoldol Owner',
            '#bank-account-number-text': '1234 5678 9000'
        }
        for selector, value in expected.items():
            if await page.locator(selector).count() != 1:
                failures.append(f'customer bank field missing: {selector}')
                continue
            actual = (await page.locator(selector).inner_text()).strip()
            if actual != value:
                failures.append(f'{selector} expected {value!r}, got {actual!r}')
        if await page.locator('#bank-qr-img').count() != 1:
            failures.append('customer bank QR image element missing')
        else:
            bank_qr_visible = await page.locator('#bank-qr-img').evaluate("el => !el.classList.contains('hidden') && !!el.getAttribute('src')")
            if not bank_qr_visible:
                failures.append('Bank QR image was not rendered from settings')

        # Admin should be able to edit the single bank account and persist it.
        await page.evaluate("document.querySelector('#admin-screen').classList.remove('hidden')")
        await page.locator(".admin-tab-btn[data-tab='settings']").dispatch_event('click')
        await page.wait_for_timeout(100)
        admin_bank_fields_present = True
        for selector in ('#admin-bank-name', '#admin-bank-account-name', '#admin-bank-account-number', '#admin-bank-qr-input'):
            if await page.locator(selector).count() != 1:
                failures.append(f'admin field missing: {selector}')
                admin_bank_fields_present = False
        if admin_bank_fields_present:
            await page.locator('#admin-bank-name').fill('Updated Bank')
            await page.locator('#admin-bank-account-name').fill('Updated Owner')
            await page.locator('#admin-bank-account-number').fill('9999 8888 7777')
            await page.locator('#admin-settings-save').click()
            await page.wait_for_timeout(100)
            saved = await page.evaluate('window.__settingsUpserts')
            saved_map = {str(row.get('key')): row.get('value') for row in saved}
            for key, value in {
                'bank_name':'Updated Bank',
                'bank_account_name':'Updated Owner',
                'bank_account_number':'9999 8888 7777'
            }.items():
                if saved_map.get(key) != value:
                    failures.append(f'admin save missing {key}={value!r}; got {saved_map.get(key)!r}')
            if not saved_map.get('bank_qr_image'):
                failures.append('admin save did not preserve/persist bank_qr_image')

        if page_errors:
            failures.append('page errors: ' + ' | '.join(page_errors))

        await context.close()

        mobile_context = await browser.new_context(
            viewport={'width': 390, 'height': 844},
            is_mobile=True,
            has_touch=True,
            device_scale_factor=3,
        )
        mobile_page = await mobile_context.new_page()
        mobile_errors = []
        mobile_page.on('pageerror', lambda exc: mobile_errors.append(str(exc)))
        await mobile_page.set_content(html, wait_until='domcontentloaded')
        await mobile_page.add_style_tag(content=css)
        await mobile_page.evaluate('history.replaceState=()=>{};history.pushState=()=>{};')
        await mobile_page.add_script_tag(content=MOCK_SUPABASE)
        await mobile_page.add_script_tag(content=config)
        await mobile_page.add_script_tag(content=auth)
        await mobile_page.add_script_tag(content=app)
        await mobile_page.wait_for_timeout(700)
        await mobile_page.evaluate("""() => {
          ['login-screen','shop-screen','admin-screen','orders-screen'].forEach(id => document.getElementById(id)?.classList.add('hidden'));
          document.getElementById('checkout-screen')?.classList.remove('hidden');
          const bank = document.querySelector("input[name='payment-method'][value='bank']");
          bank.checked = true;
          bank.dispatchEvent(new Event('change', {bubbles:true}));
        }""")
        mobile_fit = await mobile_page.evaluate("""() => {
          const bankPanel = document.getElementById('payment-detail-bank');
          const qr = document.getElementById('bank-qr-box');
          const rect = qr?.getBoundingClientRect();
          return {
            docWidth: document.documentElement.scrollWidth,
            innerWidth: window.innerWidth,
            bankHidden: bankPanel?.classList.contains('hidden'),
            qrLeft: rect?.left ?? 0,
            qrRight: rect?.right ?? 0,
          };
        }""")
        if mobile_fit['docWidth'] - mobile_fit['innerWidth'] > 1:
            failures.append(f"mobile bank checkout overflow: {mobile_fit['docWidth'] - mobile_fit['innerWidth']}px")
        if mobile_fit['bankHidden']:
            failures.append('mobile Bank Transfer detail panel stayed hidden')
        if mobile_fit['qrLeft'] < -1 or mobile_fit['qrRight'] > mobile_fit['innerWidth'] + 1:
            failures.append(f"mobile bank QR escaped viewport: {mobile_fit}")
        if mobile_errors:
            failures.append('mobile page errors: ' + ' | '.join(mobile_errors))
        await mobile_context.close()
        await browser.close()

    if failures:
        raise SystemExit('\n'.join(failures))
    print('payment-settings-runtime: PASS')


if __name__ == '__main__':
    asyncio.run(main())
