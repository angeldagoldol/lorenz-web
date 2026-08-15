import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = resolve(ROOT, 'config.js');
const PRODUCTS_DIR = resolve(ROOT, 'products');
const GENERATED_PRODUCT_IMAGE_DIR = resolve(ROOT, 'assets', 'generated-product-images');
const PUBLIC_SETTING_KEYS = new Set(['gcash_number', 'gcash_qr_image', 'bank_name', 'bank_account_name', 'bank_account_number', 'bank_qr_image', 'shop_logo_image']);

function normalizeSiteUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function extractConfigValue(source, key) {
  const quoted = source.match(new RegExp(`window\\.${key}\\s*=\\s*[\\r\\n\\s]*["']([^"']+)["']`, 'm'));
  if (quoted) return quoted[1];
  const objectValue = source.match(new RegExp(`${key}\\s*:\\s*["']([^"']+)["']`, 'm'));
  return objectValue ? objectValue[1] : '';
}

async function loadBuildConfig() {
  const source = await readFile(CONFIG_PATH, 'utf8');
  const supabaseUrl = process.env.SUPABASE_URL || extractConfigValue(source, 'SUPABASE_URL');
  const anonKey = process.env.SUPABASE_ANON_KEY || extractConfigValue(source, 'SUPABASE_ANON_KEY');
  const siteUrl = normalizeSiteUrl(process.env.SITE_URL || extractConfigValue(source, 'SITE_URL') || 'https://lorenz-web-six.vercel.app');

  if (!supabaseUrl || !anonKey || !siteUrl) {
    throw new Error('Missing SUPABASE_URL, SUPABASE_ANON_KEY, or SITE_URL for catalogue generation.');
  }

  return { supabaseUrl: normalizeSiteUrl(supabaseUrl), anonKey, siteUrl };
}

function htmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function xmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;'
  })[character]);
}

function jsonForHtml(value) {
  return JSON.stringify(value, null, 2).replace(/</g, '\\u003c');
}

function routeToken(productId) {
  const digest = createHash('sha256').update(String(productId)).digest('hex').slice(0, 12);
  return `p-${digest}`;
}

function dataUriImageExtension(mimeType) {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized === 'image/png') return 'png';
  if (normalized === 'image/webp') return 'webp';
  if (normalized === 'image/gif') return 'gif';
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'jpg';
  return null;
}

async function materializeDataUriImages(products) {
  await rm(GENERATED_PRODUCT_IMAGE_DIR, { recursive: true, force: true });
  await mkdir(GENERATED_PRODUCT_IMAGE_DIR, { recursive: true });

  const written = new Map();
  const normalized = [];

  for (const product of products || []) {
    const clone = { ...product, sizes: Array.isArray(product?.sizes) ? product.sizes.map((size) => ({ ...size })) : [] };

    for (const size of clone.sizes) {
      const image = typeof size.image === 'string' ? size.image.trim() : '';
      const match = image.match(/^data:(image\/(?:jpeg|jpg|png|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/i);
      if (!match) continue;

      const ext = dataUriImageExtension(match[1]);
      if (!ext) continue;

      let bytes;
      try {
        bytes = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
      } catch {
        continue;
      }
      if (!bytes.length) continue;

      const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 24);
      const fileName = `${digest}.${ext}`;
      const outputPath = resolve(GENERATED_PRODUCT_IMAGE_DIR, fileName);
      if (!written.has(fileName)) {
        await writeFile(outputPath, bytes);
        written.set(fileName, true);
      }
      size.image = `/assets/generated-product-images/${fileName}`;
    }

    normalized.push(clone);
  }

  return normalized;
}

function descriptionForMeta(value) {
  const clean = String(value || 'Fine everyday goods from Dagoldol Trading Co.').replace(/\s+/g, ' ').trim();
  return clean.length <= 158 ? clean : `${clean.slice(0, 155).trimEnd()}…`;
}

function formatPrice(value) {
  const number = Number(value) || 0;
  return `₱${number.toLocaleString('en-PH', { minimumFractionDigits: Number.isInteger(number) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

function unitLabel(unitType, value) {
  if (unitType === 'size') return String(value);
  if (unitType === 'sqm') return `${value} sqm`;
  return `${value} ft`;
}

function activeFlashSaleFor(productId, flashSales) {
  const now = Date.now();
  return flashSales.find((sale) => (
    String(sale.product_id) === String(productId)
    && Boolean(sale.active)
    && Number(sale.start_at) <= now
    && now <= Number(sale.end_at)
  )) || null;
}

function variantPrice(size, sale) {
  const original = Math.max(0, Number(size?.price) || 0);
  if (!sale) return { original, price: original };
  const discount = Math.max(0, Math.min(100, Number(sale.discount_percent) || 0));
  return { original, price: Math.max(0, original * (1 - discount / 100)) };
}

const LOW_STOCK_THRESHOLD = 10;

function isAvailable(size) {
  if (size?.stock === undefined || size?.stock === null || size?.stock === '') return true;
  return Number(size.stock) > 0;
}

function primaryImage(product) {
  const sizes = Array.isArray(product.sizes) ? product.sizes : [];
  return sizes.find((size) => size?.image && isAvailable(size))?.image
    || sizes.find((size) => size?.image)?.image
    || null;
}

function buildVariantRows(product, sale) {
  const sizes = Array.isArray(product.sizes) ? product.sizes : [];
  if (!sizes.length) {
    return '<p class="product-page-empty">Size and pricing information is not available yet.</p>';
  }

  return `
    <div class="product-variant-table-wrap">
      <table class="product-variant-table">
        <thead><tr><th>Option</th><th>Price</th><th>Availability</th></tr></thead>
        <tbody>
          ${sizes.map((size) => {
            const prices = variantPrice(size, sale);
            const stockIsKnown = size.stock !== undefined && size.stock !== null && size.stock !== '';
            const available = isAvailable(size);
            const stockCount = stockIsKnown ? Math.max(0, Number(size.stock) || 0) : null;
            const stockText = !available
              ? 'Out of stock'
              : stockIsKnown && stockCount <= LOW_STOCK_THRESHOLD
                ? `Only ${stockCount} left`
                : 'Available';
            const priceMarkup = sale && prices.price < prices.original
              ? `<span class="product-page-old-price">${htmlEscape(formatPrice(prices.original))}</span> ${htmlEscape(formatPrice(prices.price))}`
              : htmlEscape(formatPrice(prices.price));
            return `<tr><td>${htmlEscape(unitLabel(product.unit_type || 'feet', size.feet))}</td><td>${priceMarkup}</td><td>${htmlEscape(stockText)}</td></tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}

function buildProductStructuredData({ product, brand, sale, pageUrl, imageUrl, siteUrl }) {
  const sizes = (Array.isArray(product.sizes) ? product.sizes : []).filter(isAvailable);
  const prices = sizes.map((size) => variantPrice(size, sale).price).filter((price) => Number.isFinite(price));

  const schema = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    '@id': `${pageUrl}#product`,
    name: product.name,
    description: product.description || '',
    sku: String(product.id),
    url: pageUrl,
    isPartOf: { '@id': `${siteUrl}/#organization` }
  };

  if (imageUrl) schema.image = [imageUrl];
  if (brand?.name) schema.brand = { '@type': 'Brand', name: brand.name };

  if (prices.length) {
    schema.offers = {
      '@type': 'AggregateOffer',
      url: pageUrl,
      priceCurrency: 'PHP',
      lowPrice: Math.min(...prices).toFixed(2),
      highPrice: Math.max(...prices).toFixed(2),
      offerCount: prices.length
    };
  }

  return schema;
}

function buildBreadcrumbData(product, pageUrl, siteUrl) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Dagoldol', item: `${siteUrl}/` },
      { '@type': 'ListItem', position: 2, name: product.name, item: pageUrl }
    ]
  };
}

function productPriceSummary(product, flashSales) {
  const sale = activeFlashSaleFor(product.id, flashSales);
  const sizes = (Array.isArray(product.sizes) ? product.sizes : []).filter(isAvailable);
  const prices = sizes.map((size) => variantPrice(size, sale).price).filter((price) => Number.isFinite(price));
  if (!prices.length) return 'Price unavailable';
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  return low === high ? formatPrice(low) : `${formatPrice(low)} – ${formatPrice(high)}`;
}

function buildProductsIndexPage({ products, brandMap, flashSales, routeMap, siteUrl }) {
  const pageUrl = `${siteUrl}/products/`;
  const itemList = (products || [])
    .filter((product) => product?.id && product?.name && routeMap[String(product.id)])
    .map((product, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      url: `${siteUrl}${routeMap[String(product.id)]}`,
      name: product.name
    }));

  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    '@id': `${pageUrl}#products`,
    name: 'Dagoldol product catalogue',
    itemListElement: itemList
  };

  const cards = (products || [])
    .filter((product) => product?.id && product?.name && routeMap[String(product.id)])
    .map((product) => {
      const route = routeMap[String(product.id)];
      const brand = brandMap.get(String(product.brand_id)) || null;
      const imageUrl = primaryImage(product);
      const price = productPriceSummary(product, flashSales);
      return `
        <article class="product-index-card">
          <a class="product-index-media" href="${htmlEscape(route)}" aria-label="View ${htmlEscape(product.name)}">
            ${imageUrl
              ? `<img src="${htmlEscape(imageUrl)}" alt="${htmlEscape(product.name)}" loading="lazy" decoding="async">`
              : `<span class="product-page-placeholder" aria-hidden="true">${htmlEscape(String(product.name).charAt(0).toUpperCase())}</span>`}
          </a>
          <div class="product-index-content">
            ${brand?.name ? `<p class="product-brand-tag">${htmlEscape(brand.name)}</p>` : ''}
            <h2><a href="${htmlEscape(route)}">${htmlEscape(product.name)}</a></h2>
            <p>${htmlEscape(descriptionForMeta(product.description))}</p>
            <strong>${htmlEscape(price)}</strong>
          </div>
        </article>`;
    }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0">
<title>Products | Dagoldol Trading Co.</title>
<meta name="description" content="Browse the current Dagoldol Trading Co. product catalogue with public product details, prices, and availability.">
<meta name="robots" content="index,follow,max-image-preview:large">
<link rel="canonical" href="${htmlEscape(pageUrl)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Dagoldol">
<meta property="og:title" content="Products | Dagoldol Trading Co.">
<meta property="og:description" content="Browse the current Dagoldol Trading Co. product catalogue.">
<meta property="og:url" content="${htmlEscape(pageUrl)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/style.css">
<link rel="stylesheet" href="/phase2-fixes.css">
<link rel="stylesheet" href="/phase3-fixes.css">
<link rel="stylesheet" href="/product-page.css">
<script type="application/ld+json">${jsonForHtml(structuredData)}</script>
</head>
<body class="product-page-body">
<a class="skip-link" href="#product-index">Skip to products</a>
<header class="product-page-header">
  <a class="brand-mark" href="/" aria-label="Dagoldol home"><span>Dagoldol</span></a>
  <nav class="product-page-nav" aria-label="Shop information">
    <a href="/shipping-delivery/">Delivery</a>
    <a href="/returns/">Returns</a>
    <a href="/contact/">Contact</a>
  </nav>
</header>
<main id="product-index" class="product-page-main product-index-main">
  <nav class="product-breadcrumb" aria-label="Breadcrumb"><a href="/">Shop</a><span aria-hidden="true">/</span><span>Products</span></nav>
  <div class="product-index-heading">
    <p class="eyebrow">Public catalogue</p>
    <h1>Products</h1>
    <p>Choose a product to view its current public options. Cart and checkout actions continue in the main Dagoldol shop.</p>
  </div>
  <div class="product-index-grid">
    ${cards || '<p class="product-page-empty">No public products are available right now.</p>'}
  </div>
</main>
<footer class="shop-footer product-page-footer">
  <nav class="shop-footer-nav" aria-label="Shop information">
    <a href="/about/">About</a><a href="/faq/">FAQ</a><a href="/shipping-delivery/">Shipping &amp; Delivery</a><a href="/returns/">Returns</a><a href="/contact/">Contact</a><a href="/terms/">Terms</a><a href="/privacy/">Privacy</a>
  </nav>
  <p>&copy; 2026 Dagoldol Trading Co.</p>
</footer>
</body>
</html>`;
}

function buildProductPage({ product, brand, rating, flashSales, route, siteUrl }) {
  const pageUrl = `${siteUrl}${route}`;
  const sale = activeFlashSaleFor(product.id, flashSales);
  const imageUrl = primaryImage(product);
  const metaDescription = descriptionForMeta(product.description);
  const schema = buildProductStructuredData({ product, brand, sale, pageUrl, imageUrl, siteUrl });
  const breadcrumb = buildBreadcrumbData(product, pageUrl, siteUrl);
  const queryId = encodeURIComponent(String(product.id));
  const ratingText = rating && rating.count
    ? `<p class="product-page-rating">★ ${htmlEscape(rating.average.toFixed(1))} <span>(${rating.count} rating${rating.count === 1 ? '' : 's'})</span></p>`
    : '<p class="product-page-rating product-page-rating-muted">No ratings yet</p>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0">
<title>${htmlEscape(product.name)} | Dagoldol Trading Co.</title>
<meta name="description" content="${htmlEscape(metaDescription)}">
<meta name="robots" content="index,follow,max-image-preview:large">
<link rel="canonical" href="${htmlEscape(pageUrl)}">
<meta property="og:type" content="product">
<meta property="og:site_name" content="Dagoldol">
<meta property="og:title" content="${htmlEscape(product.name)} | Dagoldol Trading Co.">
<meta property="og:description" content="${htmlEscape(metaDescription)}">
<meta property="og:url" content="${htmlEscape(pageUrl)}">
${imageUrl ? `<meta property="og:image" content="${htmlEscape(imageUrl)}">` : ''}
<meta name="twitter:card" content="${imageUrl ? 'summary_large_image' : 'summary'}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/style.css">
<link rel="stylesheet" href="/phase2-fixes.css">
<link rel="stylesheet" href="/phase3-fixes.css">
<link rel="stylesheet" href="/product-page.css">
<script type="application/ld+json">${jsonForHtml(schema)}</script>
<script type="application/ld+json">${jsonForHtml(breadcrumb)}</script>
</head>
<body class="product-page-body">
<a class="skip-link" href="#product-detail">Skip to product details</a>
<header class="product-page-header">
  <a class="brand-mark" href="/" aria-label="Dagoldol home"><span>Dagoldol</span></a>
  <nav class="product-page-nav" aria-label="Shop information">
    <a href="/shipping-delivery/">Delivery</a>
    <a href="/returns/">Returns</a>
    <a href="/contact/">Contact</a>
  </nav>
</header>
<main id="product-detail" class="product-page-main">
  <nav class="product-breadcrumb" aria-label="Breadcrumb"><a href="/">Shop</a><span aria-hidden="true">/</span><span>${htmlEscape(product.name)}</span></nav>
  <article class="product-page-card">
    <div class="product-page-media">
      ${imageUrl
        ? `<img src="${htmlEscape(imageUrl)}" alt="${htmlEscape(product.name)}" decoding="async">`
        : `<div class="product-page-placeholder" aria-hidden="true"><span>${htmlEscape(String(product.name || '?').charAt(0).toUpperCase())}</span></div>`}
      ${sale ? `<span class="product-page-sale">-${htmlEscape(String(Number(sale.discount_percent) || 0))}% ${htmlEscape(sale.label || 'Flash Sale')}</span>` : ''}
    </div>
    <div class="product-page-content">
      ${brand?.name ? `<p class="product-brand-tag">${htmlEscape(brand.name)}</p>` : ''}
      <h1>${htmlEscape(product.name)}</h1>
      <p class="product-page-description">${htmlEscape(product.description || '')}</p>
      ${ratingText}
      <section aria-labelledby="product-options-heading">
        <h2 id="product-options-heading">Available options</h2>
        ${buildVariantRows(product, sale)}
      </section>
      <div class="product-page-actions">
        <a class="btn-primary product-page-button" href="/?product=${queryId}&action=cart">Choose size &amp; add to cart</a>
        <a class="btn-secondary product-page-button" href="/?product=${queryId}&action=order">Choose size &amp; order</a>
      </div>
      <p class="product-page-note">Final availability, delivery fee, promotion eligibility, and payment details are confirmed in the shop checkout flow.</p>
    </div>
  </article>
</main>
<footer class="shop-footer product-page-footer">
  <nav class="shop-footer-nav" aria-label="Shop information">
    <a href="/about/">About</a><a href="/faq/">FAQ</a><a href="/shipping-delivery/">Shipping &amp; Delivery</a><a href="/returns/">Returns</a><a href="/terms/">Terms</a><a href="/privacy/">Privacy</a>
  </nav>
  <p>&copy; 2026 Dagoldol Trading Co.</p>
</footer>
</body>
</html>`;
}

async function fetchRest(config, table, query) {
  const url = `${config.supabaseUrl}/rest/v1/${table}?${query}`;
  const response = await fetch(url, {
    headers: {
      apikey: config.anonKey,
      Authorization: `Bearer ${config.anonKey}`,
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Supabase REST request failed for ${table} (${response.status}): ${body.slice(0, 500)}`);
  }

  return response.json();
}

function aggregateRatings(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const key = String(row.product_id);
    const current = map.get(key) || { sum: 0, count: 0 };
    current.sum += Number(row.value) || 0;
    current.count += 1;
    map.set(key, current);
  }
  return new Map(Array.from(map, ([key, value]) => [key, { count: value.count, average: value.count ? value.sum / value.count : 0 }]));
}

async function writeSitemap(siteUrl, routes) {
  const fixedRoutes = ['/', '/products/', '/about/', '/faq/', '/shipping-delivery/', '/returns/', '/contact/', '/terms/', '/privacy/'];
  const urls = [...fixedRoutes, ...routes]
    .map((route) => `  <url>\n    <loc>${xmlEscape(`${siteUrl}${route}`)}</loc>\n  </url>`)
    .join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  await writeFile(resolve(ROOT, 'sitemap.xml'), xml, 'utf8');
}

async function main() {
  const config = await loadBuildConfig();
  const [products, brands, ratings, flashSales, settings] = await Promise.all([
    fetchRest(config, 'products', 'select=id,name,description,accent,icon,sizes,brand_id,unit_type&order=name.asc'),
    fetchRest(config, 'brands', 'select=id,name,logo,description'),
    fetchRest(config, 'ratings', 'select=product_id,value'),
    fetchRest(config, 'flash_sales', 'select=id,product_id,discount_percent,start_at,end_at,active,label'),
    fetchRest(config, 'settings', 'select=key,value')
  ]);

  const normalizedProducts = await materializeDataUriImages(products || []);
  const brandMap = new Map((brands || []).map((brand) => [String(brand.id), brand]));
  const ratingMap = aggregateRatings(ratings);
  const routeMap = {};
  const routes = [];

  await rm(PRODUCTS_DIR, { recursive: true, force: true });
  await mkdir(PRODUCTS_DIR, { recursive: true });

  for (const product of normalizedProducts) {
    if (!product?.id || !product?.name) continue;
    const token = routeToken(product.id);
    const route = `/products/${token}/`;
    const directory = resolve(PRODUCTS_DIR, token);
    routeMap[String(product.id)] = route;
    routes.push(route);

    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, 'index.html'), buildProductPage({
      product,
      brand: brandMap.get(String(product.brand_id)) || null,
      rating: ratingMap.get(String(product.id)) || null,
      flashSales: flashSales || [],
      route,
      siteUrl: config.siteUrl
    }), 'utf8');
  }

  await writeFile(resolve(PRODUCTS_DIR, 'index.html'), buildProductsIndexPage({
    products: normalizedProducts,
    brandMap,
    flashSales: flashSales || [],
    routeMap,
    siteUrl: config.siteUrl
  }), 'utf8');
  await writeFile(resolve(ROOT, 'product-routes.json'), `${JSON.stringify(routeMap, null, 2)}\n`, 'utf8');
  const publicSettings = (settings || []).filter((row) => PUBLIC_SETTING_KEYS.has(String(row?.key || '')));

  await writeFile(resolve(ROOT, 'catalogue-snapshot.json'), `${JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    products: normalizedProducts,
    brands: brands || [],
    ratings: ratings || [],
    flashSales: flashSales || [],
    settings: publicSettings
  }, null, 2)}\n`, 'utf8');
  await writeSitemap(config.siteUrl, routes);

  console.log(`[Dagoldol Phase 3] Generated ${routes.length} crawlable product page(s), the product index, and catalogue-snapshot.json.`);
}

main().catch((error) => {
  console.error('[Dagoldol Phase 3] Public catalogue generation failed.');
  console.error(error);
  process.exitCode = 1;
});
