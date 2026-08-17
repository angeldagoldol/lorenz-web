import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const REQUIRED_FILES = [
  'index.html',
  'style.css',
  'script.js',
  'auth-resilience.js',
  'delivery-map.js',
  'config.js',
  'pill-buttons.css',
  'liquid-chrome.js',
  'phase2-core.js',
  'phase2-accessibility.js',
  'phase2-fixes.css',
  'phase3-fixes.css',
  'product-page.css',
  'info-page.css',
  'robots.txt',
  'sitemap.xml',
  'vercel.json',
  'product-routes.json',
  'database/00-phase3-live-preflight.sql',
  'database/phase3-security-and-storage.sql',
  'README.md',
  'VERIFICATION.md',
  'supabase/functions/delete-auth-user/index.ts',
  'about/index.html',
  'faq/index.html',
  'shipping-delivery/index.html',
  'returns/index.html',
  'terms/index.html',
  'privacy/index.html',
  'contact/index.html',
  'products/index.html',
  'tests/payment-settings-contract.mjs',
  'tests/payment-settings-runtime.spec.py',
  'tests/mobile-fast-bootstrap.test.mjs',
  'tests/device-auth-resilience.test.mjs',
  'tests/delivery-map-contract.test.mjs',
  'tests/delivery-origin-contract.test.mjs',
  'tests/mobile-map-reliability.test.mjs',
  'tests/geolocation-reliability.test.mjs',
  'tests/current-location-map-v2.test.mjs'
];

const REQUIRED_INDEX_IDS = [
  'login-screen', 'shop-screen', 'admin-screen', 'catalogue', 'cart-btn',
  'size-modal', 'checkout-screen', 'checkout-back-btn', 'order-form',
  'orders-screen', 'orders-back-btn', 'orders-list', 'profile-modal',
  'contact-modal', 'chat-modal', 'delivery-map-modal', 'delivery-map-canvas', 'toast-container'
];

function collectDoubleQuotedIds(html) {
  const ids = [];
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) ids.push(match[1]);
  return ids;
}

function duplicateValues(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts].filter(([, count]) => count > 1).map(([value]) => value);
}

async function verifyHtmlFile(relativePath) {
  const fullPath = resolve(ROOT, relativePath);
  const html = await readFile(fullPath, 'utf8');
  const duplicates = duplicateValues(collectDoubleQuotedIds(html));
  if (duplicates.length) throw new Error(`${relativePath} contains duplicate id(s): ${duplicates.join(', ')}`);
  if (!/<title>[^<]+<\/title>/i.test(html)) throw new Error(`${relativePath} is missing a non-empty <title>.`);
  if (!/<meta\s+name="viewport"/i.test(html)) throw new Error(`${relativePath} is missing the viewport meta tag.`);
  return html;
}

async function main() {
  for (const relativePath of REQUIRED_FILES) await access(resolve(ROOT, relativePath));

  const indexHtml = await verifyHtmlFile('index.html');
  const index1Html = await verifyHtmlFile('index1.html');

  const publicDirectories = ['about', 'faq', 'shipping-delivery', 'returns', 'terms', 'privacy', 'contact', 'products'];
  for (const directory of publicDirectories) await verifyHtmlFile(`${directory}/index.html`);

  for (const id of REQUIRED_INDEX_IDS) {
    if (!indexHtml.includes(`id="${id}"`)) throw new Error(`index.html is missing required id="${id}".`);
  }
  for (const id of ['bank-name-text', 'bank-account-name-text', 'bank-account-number-text', 'bank-qr-img', 'bank-qr-placeholder']) {
    if (!indexHtml.includes(`id="${id}"`)) throw new Error(`index.html is missing Bank Transfer checkout id="${id}".`);
  }
  if (!indexHtml.includes('viewport-fit=cover') || !index1Html.includes('viewport-fit=cover')) {
    throw new Error('Mobile safe-area viewport metadata is missing from index.html or index1.html.');
  }
  if (!indexHtml.includes('rel="preconnect" href="https://rvrjkfbenramappteuae.supabase.co"')) {
    throw new Error('index.html is missing the Supabase preconnect performance hint.');
  }
  if (!indexHtml.includes('rel="dns-prefetch" href="//rvrjkfbenramappteuae.supabase.co"')) {
    throw new Error('index.html is missing the Supabase DNS prefetch hint.');
  }
  for (const href of ['./phase2-fixes.css?v=3.3.3', './phase3-fixes.css?v=3.3.3']) {
    if (!indexHtml.includes(`href="${href}"`)) {
      throw new Error(`index.html does not direct-load critical mobile stylesheet: ${href}`);
    }
  }
  if (!indexHtml.includes('src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2" defer')) {
    throw new Error('index.html does not start the Supabase runtime early with defer.');
  }
  if (!indexHtml.includes('src="script.js?v=3.3.3" defer')) {
    throw new Error('index.html is missing the deferred Phase 3.3.3 application runtime.');
  }

  const configSource = await readFile(resolve(ROOT, 'config.js'), 'utf8');
  if (!configSource.includes('PHASE3_ENABLED: true')) throw new Error('config.js does not enable Phase 3.');
  if (!configSource.includes('./phase3-fixes.css')) throw new Error('config.js does not load phase3-fixes.css.');
  if (!configSource.includes('ASSET_VERSION: "3.3.3"')) throw new Error('config.js does not expose the mobile performance asset version.');

  const vercelConfig = JSON.parse(await readFile(resolve(ROOT, 'vercel.json'), 'utf8'));
  const supabaseProxy = (vercelConfig.rewrites || []).find(rule => rule.source === '/api/supabase/:path*');
  if (!supabaseProxy || supabaseProxy.destination !== 'https://rvrjkfbenramappteuae.supabase.co/:path*') {
    throw new Error('vercel.json is missing the fixed-origin Supabase fallback proxy.');
  }

  const scriptSource = await readFile(resolve(ROOT, 'script.js'), 'utf8');
  for (const route of ['CHECKOUT: "/checkout"', 'ORDERS: "/account/orders"', 'ADMIN: "/admin"']) {
    if (!scriptSource.includes(route)) throw new Error(`script.js is missing app route contract: ${route}`);
  }
  if (!scriptSource.includes('get_public_recommendation_signals')) throw new Error('script.js is missing the privacy-preserving recommendation RPC integration.');
  if (!scriptSource.includes('status_override: 0')) throw new Error('script.js is missing the persisted initial order status.');
  if (!scriptSource.includes('window.SUPABASE_URL') || !scriptSource.includes('window.SUPABASE_ANON_KEY')) {
    throw new Error('script.js must consume the window-scoped Supabase bootstrap variables.');
  }
  if (!scriptSource.includes('persistSession: true') || !scriptSource.includes('autoRefreshToken: true')) {
    throw new Error('script.js must explicitly persist and refresh independent browser sessions.');
  }
  if (!indexHtml.includes('src="auth-resilience.js?v=3.3.3" defer')) {
    throw new Error('index.html is missing the resilient Supabase transport runtime.');
  }
  if (!scriptSource.includes('DAGOLDOL_AUTH_RESILIENCE') || !scriptSource.includes('fetch: resilientSupabaseFetch')) {
    throw new Error('script.js is missing the resilient Supabase fetch integration.');
  }
  if (!scriptSource.includes('describeAuthError(error') || !scriptSource.includes('describeAuthError(err')) {
    throw new Error('script.js is missing structured auth error handling.');
  }
  if (/supabase\.auth\.signOut\(\s*\)/.test(scriptSource)) {
    throw new Error('script.js contains a global-by-default bare signOut() call; browser logout must remain local to the current device.');
  }
  if (!scriptSource.includes('signOut({ scope: "local" })')) {
    throw new Error('script.js is missing current-device-only Supabase sign out.');
  }
  if (!scriptSource.includes('const DELIVERY_FREE_KM_THRESHOLD = 5;') ||
      !scriptSource.includes('const DELIVERY_RATE_PER_KM = 60;') ||
      !scriptSource.includes('const DELIVERY_FALLBACK_FEE = 600;')) {
    throw new Error('Delivery pricing constants changed unexpectedly; the cancelled ₱399 pricing change must not be present.');
  }
  for (const marker of [
    'checkoutPinnedLocation',
    'profilePinnedLocation',
    'adminDeliveryOriginDraft',
    'calculateDeliveryFeeForCoords',
    'serializePinnedLocation',
    'openDeliveryMapForCheckout',
    'openDeliveryMapForProfile',
    'delivery_origin_address',
    'delivery_origin_latitude',
    'delivery_origin_longitude',
    'admin-delivery-origin-open'
  ]) {
    if (!scriptSource.includes(marker)) throw new Error(`script.js is missing delivery map integration: ${marker}`);
  }
  for (const id of [
    'checkout-location-open', 'checkout-location-current',
    'profile-location-open', 'profile-location-current',
    'profile-address', 'profile-city', 'profile-postal', 'profile-landmark',
    'delivery-map-current-location', 'delivery-map-confirm'
  ]) {
    if (!indexHtml.includes(`id="${id}"`)) throw new Error(`index.html is missing delivery location id="${id}".`);
  }
  if (/leaflet(?:\.js|@)/i.test(indexHtml)) throw new Error('Leaflet must remain lazy-loaded and must not be included directly in index.html.');

  const deliveryMapSource = await readFile(resolve(ROOT, 'delivery-map.js'), 'utf8');
  for (const marker of ['openDeliveryMap', 'reverseGeocodePin', 'NOMINATIM_MIN_INTERVAL_MS = 1100', 'MAP_LIBRARY_LOAD_TIMEOUT_MS', 'LEAFLET_VERSION = "1.9.4"', 'LEAFLET_JS_URLS', 'tile.openstreetmap.org/{z}/{x}/{y}.png', 'invalidateSize', 'draggable: true']) {
    if (!deliveryMapSource.includes(marker)) throw new Error(`delivery-map.js is missing contract: ${marker}`);
  }
  for (const marker of ['startCurrentLocationTracking', 'getReliableCurrentPosition', 'getCurrentLocationSelection', 'getGeolocationPermissionState', 'getLocationFailureMessage', 'watchPosition', 'clearWatch', 'enableHighAccuracy: true', 'enableHighAccuracy: false']) {
    if (!deliveryMapSource.includes(marker)) throw new Error(`delivery-map.js is missing resilient geolocation contract: ${marker}`);
  }
  if (!indexHtml.includes('The pin moves as soon as your device reports a position')) {
    throw new Error('index.html is missing current-location acquisition guidance.');
  }
  if (!scriptSource.includes('deliveryMapCurrentLocationBtn.textContent = "Locating…"')) {
    throw new Error('script.js is missing current-location progress feedback.');
  }
  const permissionsPolicy = (vercelConfig.headers || []).flatMap(rule => rule.headers || []).find(header => header.key === 'Permissions-Policy');
  if (!permissionsPolicy || !permissionsPolicy.value.includes('geolocation=(self)')) {
    throw new Error('vercel.json must allow same-origin geolocation for the explicit Use my current location action.');
  }
  const cspHeader = (vercelConfig.headers || []).flatMap(rule => rule.headers || []).find(header => header.key === 'Content-Security-Policy');
  if (!cspHeader || !cspHeader.value.includes('https://cdn.jsdelivr.net') || !cspHeader.value.includes('https://unpkg.com') || !cspHeader.value.includes('https://tile.openstreetmap.org')) {
    throw new Error('vercel.json CSP is missing lazy Leaflet/OpenStreetMap requirements.');
  }
  for (const marker of [
    'function shouldUseFastMobileBootstrap()',
    'function renderCatalogueFromSnapshotFast()',
    'function hydrateCatalogueLiveAfterFastRender()',
    'function primeSettingsFromSnapshot()',
    'function refreshSettingsLive('
  ]) {
    if (!scriptSource.includes(marker)) throw new Error(`script.js is missing mobile performance contract: ${marker}`);
  }
  if (!scriptSource.includes('scheduleNonCriticalShopWork(hydrateCatalogueLiveAfterFastRender, 300)')) {
    throw new Error('script.js does not defer live catalogue hydration after the snapshot-first render.');
  }
  if (!scriptSource.includes('DELIVERY_ESTIMATE_MIN_DAYS = 3') || !scriptSource.includes('DELIVERY_ESTIMATE_MAX_DAYS = 6')) {
    throw new Error('script.js is missing the deterministic 3–6 day delivery-estimate contract.');
  }
  if (scriptSource.includes('3 + Math.floor(Math.random() * 4)')) throw new Error('script.js still contains the old randomized delivery estimate.');
  if (scriptSource.includes('suggestedPeopleCache') || scriptSource.includes('fetchSuggestedPeople')) {
    throw new Error('script.js still contains the removed random profile-suggestion data flow.');
  }
  for (const key of ['bank_name', 'bank_account_name', 'bank_account_number', 'bank_qr_image']) {
    if (!scriptSource.includes(key)) throw new Error(`script.js is missing bank payment setting key: ${key}`);
    if (!scriptSource.includes(`saveSetting("${key}"`)) throw new Error(`script.js admin payment settings do not persist: ${key}`);
  }
  for (const id of ['admin-bank-name', 'admin-bank-account-name', 'admin-bank-account-number', 'admin-bank-qr-input', 'admin-bank-qr-preview', 'admin-bank-qr-remove']) {
    if (!scriptSource.includes(id)) throw new Error(`script.js is missing admin bank-payment control: ${id}`);
  }
  if (!scriptSource.includes('uploadImageToStorage(file, "payment-settings", "bank-qr", 600)')) {
    throw new Error('script.js is missing bank QR upload integration with the payment-settings bucket.');
  }

  const pillSource = await readFile(resolve(ROOT, 'pill-buttons.css'), 'utf8');
  const pillMechanicsMatch = pillSource.match(/\.btn-primary,[\s\S]*?\{\s*position:\s*relative;[\s\S]*?\}/);
  if (!pillMechanicsMatch) throw new Error('pill-buttons.css is missing the base pill mechanics block.');
  if (/\.password-toggle-btn\s*,?/.test(pillMechanicsMatch[0])) {
    throw new Error('pill-buttons.css still overrides password-toggle positioning with the pill mechanics block.');
  }

  const generatorSource = await readFile(resolve(ROOT, 'scripts/generate-public-catalogue.mjs'), 'utf8');
  for (const key of ['bank_name', 'bank_account_name', 'bank_account_number', 'bank_qr_image']) {
    if (!generatorSource.includes(`'${key}'`) && !generatorSource.includes(`"${key}"`)) {
      throw new Error(`Public catalogue settings allowlist is missing: ${key}`);
    }
  }

  const phase3Source = await readFile(resolve(ROOT, 'phase3-fixes.css'), 'utf8');
  const style1Source = await readFile(resolve(ROOT, 'style1.css'), 'utf8');
  for (const [name, css] of [['phase3-fixes.css', phase3Source], ['style1.css', style1Source]]) {
    if (!css.includes('DAGOLDOL STATIC LIQUID CHROME')) {
      throw new Error(`${name} is missing the rich static LiquidChrome fallback.`);
    }
    if ((css.match(/radial-gradient\(/g) || []).length < 4) {
      throw new Error(`${name} static background is missing layered gradient depth.`);
    }
  }
  if (!style1Source.includes('.contact-card__value') || !style1Source.includes('overflow-wrap:anywhere')) {
    throw new Error('style1.css is missing the 320px My Info contact-value overflow fix.');
  }

  const liquidSource = await readFile(resolve(ROOT, 'liquid-chrome.js'), 'utf8');
  const staticDecision = liquidSource.indexOf('if (shouldUseStaticBackground())');
  const oglLoad = liquidSource.indexOf('loadOglModule()', staticDecision);
  if (staticDecision < 0 || oglLoad <= staticDecision) {
    throw new Error('liquid-chrome.js must decide the mobile static path before loading OGL.');
  }

  const pixelTrailSource = await readFile(resolve(ROOT, 'pixel-trail.js'), 'utf8');
  if (!pixelTrailSource.includes('scratchCount: 3') || !pixelTrailSource.includes("maxAge: 220")) {
    throw new Error('The approved three-scratch PixelTrail variant is not preserved.');
  }

  const phase2AccessibilitySource = await readFile(resolve(ROOT, 'phase2-accessibility.js'), 'utf8');
  if (!phase2AccessibilitySource.includes('restoreTrackedZoomFocus')) {
    throw new Error('phase2-accessibility.js is missing lightbox focus restoration for hide/remove transitions.');
  }

  const migrationSource = await readFile(resolve(ROOT, 'database/phase3-security-and-storage.sql'), 'utf8');
  if (!migrationSource.includes("item ->> 'productId' = ratings.product_id::text")) {
    throw new Error('Phase 3 ratings policy is missing the product-id type-safe comparison.');
  }

  const routes = JSON.parse(await readFile(resolve(ROOT, 'product-routes.json'), 'utf8'));
  if (!routes || Array.isArray(routes) || typeof routes !== 'object') throw new Error('product-routes.json must contain an object.');

  JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8'));
  JSON.parse(await readFile(resolve(ROOT, 'vercel.json'), 'utf8'));

  const productEntries = await readdir(resolve(ROOT, 'products'), { withFileTypes: true });
  const generatedProductDirectories = productEntries.filter((entry) => entry.isDirectory()).length;

  console.log(`[Dagoldol verify] Source contract valid. Generated product directories currently present: ${generatedProductDirectories}.`);
}

main().catch((error) => {
  console.error('[Dagoldol verify] FAILED');
  console.error(error.message || error);
  process.exitCode = 1;
});
