import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const REQUIRED_FILES = [
  'index.html',
  'style.css',
  'script.js',
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
  'products/index.html'
];

const REQUIRED_INDEX_IDS = [
  'login-screen', 'shop-screen', 'admin-screen', 'catalogue', 'cart-btn',
  'size-modal', 'checkout-screen', 'checkout-back-btn', 'order-form',
  'orders-screen', 'orders-back-btn', 'orders-list', 'profile-modal',
  'contact-modal', 'chat-modal', 'toast-container'
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
  await verifyHtmlFile('index1.html');

  const publicDirectories = ['about', 'faq', 'shipping-delivery', 'returns', 'terms', 'privacy', 'contact', 'products'];
  for (const directory of publicDirectories) await verifyHtmlFile(`${directory}/index.html`);

  for (const id of REQUIRED_INDEX_IDS) {
    if (!indexHtml.includes(`id="${id}"`)) throw new Error(`index.html is missing required id="${id}".`);
  }

  const configSource = await readFile(resolve(ROOT, 'config.js'), 'utf8');
  if (!configSource.includes('PHASE3_ENABLED: true')) throw new Error('config.js does not enable Phase 3.');
  if (!configSource.includes('loadCSS("./phase3-fixes.css")')) throw new Error('config.js does not load phase3-fixes.css.');

  const scriptSource = await readFile(resolve(ROOT, 'script.js'), 'utf8');
  for (const route of ['CHECKOUT: "/checkout"', 'ORDERS: "/account/orders"', 'ADMIN: "/admin"']) {
    if (!scriptSource.includes(route)) throw new Error(`script.js is missing app route contract: ${route}`);
  }
  if (!scriptSource.includes('get_public_recommendation_signals')) throw new Error('script.js is missing the privacy-preserving recommendation RPC integration.');
  if (!scriptSource.includes('status_override: 0')) throw new Error('script.js is missing the persisted initial order status.');
  if (!scriptSource.includes('createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY)')) throw new Error('script.js must consume the window-scoped Supabase bootstrap variables.');
  if (!scriptSource.includes('DELIVERY_ESTIMATE_MIN_DAYS = 3') || !scriptSource.includes('DELIVERY_ESTIMATE_MAX_DAYS = 6')) {
    throw new Error('script.js is missing the deterministic 3–6 day delivery-estimate contract.');
  }
  if (scriptSource.includes('3 + Math.floor(Math.random() * 4)')) throw new Error('script.js still contains the old randomized delivery estimate.');
  if (scriptSource.includes('suggestedPeopleCache') || scriptSource.includes('fetchSuggestedPeople')) {
    throw new Error('script.js still contains the removed random profile-suggestion data flow.');
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
