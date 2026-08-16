import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../', import.meta.url);
const script = fs.readFileSync(new URL('../script.js', import.meta.url), 'utf8');
const phase3 = fs.readFileSync(new URL('../phase3-fixes.css', import.meta.url), 'utf8');
const style1 = fs.readFileSync(new URL('../style1.css', import.meta.url), 'utf8');
const index = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const index1 = fs.readFileSync(new URL('../index1.html', import.meta.url), 'utf8');
const liquid = fs.readFileSync(new URL('../liquid-chrome.js', import.meta.url), 'utf8');

function sliceFunction(source, name) {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} must exist`);
  const signatureEnd = source.indexOf(')', start);
  const brace = source.indexOf('{', signatureEnd);
  assert.notEqual(brace, -1, `${name} must have a body`);
  let depth = 0;
  for (let i = brace; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Could not parse ${name}`);
}

test('mobile/slow-network bootstrap policy exists and is scoped to constrained clients', () => {
  const fn = sliceFunction(script, 'shouldUseFastMobileBootstrap');
  assert.match(fn, /innerWidth|clientWidth/);
  assert.match(fn, /maxTouchPoints|pointer:\s*coarse|hover:\s*none/);
  assert.match(fn, /saveData|effectiveType/);
  assert.match(fn, /720|768/);
});

test('fast catalogue path renders deploy snapshot before live hydration', () => {
  const fn = sliceFunction(script, 'renderCatalogueFromSnapshotFast');
  assert.match(fn, /loadCatalogueSnapshot\(/);
  assert.match(fn, /snapshot\.products/);
  assert.match(fn, /renderCatalogueList\(/);
  assert.match(fn, /return\s+true/);
});

test('live hydration refreshes catalogue dependencies without clearing the visible snapshot first', () => {
  const fn = sliceFunction(script, 'hydrateCatalogueLiveAfterFastRender');
  assert.match(fn, /fetchLiveProducts\(\)/);
  assert.match(fn, /loadRatingsMap\(\)/);
  assert.match(fn, /loadBrands\(\)/);
  assert.match(fn, /loadFlashSales\(\)/);
  assert.match(fn, /loadBundles\(\)/);
  assert.match(fn, /renderCatalogueList\(\)/);
  assert.doesNotMatch(fn, /catalogue\.innerHTML\s*=\s*buildSkeletonCards/);
});

test('session startup primes snapshot settings and does not block mobile first render on live settings', () => {
  const fn = sliceFunction(script, 'initSession');
  assert.match(fn, /shouldUseFastMobileBootstrap\(\)/);
  assert.match(fn, /primeSettingsFromSnapshot\(\)/);
  assert.match(fn, /refreshSettingsLive/);
});

test('static mobile LiquidChrome uses a real optimized image plus a dark CSS fallback', () => {
  const assetPath = new URL('../assets/mobile-liquid-chrome.webp', import.meta.url);
  assert.equal(fs.existsSync(assetPath), true, 'optimized static mobile background asset must exist');
  assert.ok(fs.statSync(assetPath).size > 10_000, 'mobile background should contain a real rendered visual');
  assert.ok(fs.statSync(assetPath).size < 350_000, 'mobile background must stay lightweight');
  for (const css of [phase3, style1]) {
    assert.match(css, /DAGOLDOL STATIC LIQUID CHROME/);
    assert.match(css, /url\(["']?\.\/assets\/mobile-liquid-chrome\.webp["']?\)/);
    assert.match(css, /linear-gradient|radial-gradient/);
    const section = css.match(/DAGOLDOL STATIC LIQUID CHROME[\s\S]*$/)?.[0] || '';
    assert.doesNotMatch(section, /@keyframes|animation\s*:/);
  }
});

test('mobile critical CSS, safe-area viewport, and connection warm-up hints ship from the head', () => {
  assert.match(index, /viewport-fit=cover/);
  assert.match(index1, /viewport-fit=cover/);
  assert.match(index, /rel="preconnect"\s+href="https:\/\/rvrjkfbenramappteuae\.supabase\.co"/);
  assert.match(index, /rel="dns-prefetch"\s+href="\/\/rvrjkfbenramappteuae\.supabase\.co"/);
  assert.match(index, /rel="preconnect"\s+href="https:\/\/cdn\.jsdelivr\.net"/);
  assert.match(index, /href="\.\/phase2-fixes\.css\?v=3\.2\.0"/);
  assert.match(index, /href="\.\/phase3-fixes\.css\?v=3\.2\.0"/);
  assert.match(index, /src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@2"\s+defer/);
  assert.match(index, /src="script\.js\?v=3\.2\.0"\s+defer/);
});

test('mobile static path exits before OGL module download', () => {
  const fn = sliceFunction(liquid, 'createLiquidChrome');
  const staticIndex = fn.indexOf('shouldUseStaticBackground()');
  const oglIndex = fn.indexOf('loadOglModule()');
  assert.ok(staticIndex >= 0 && oglIndex > staticIndex, 'static mobile decision must happen before OGL import');
});

test('video-matched desktop PixelTrail source stays unchanged by the mobile performance feature', () => {
  const pixel = fs.readFileSync(new URL('../pixel-trail.js', import.meta.url), 'utf8');
  assert.match(pixel, /scratchCount:\s*3/);
  assert.match(pixel, /maxAge:\s*220/);
  assert.match(pixel, /color:\s*['"]#1A00FE['"]/);
});


test('first product image is prioritized without eagerly loading the whole catalogue', () => {
  const fn = sliceFunction(script, 'buildProductCardPhoto');
  assert.match(fn, /index\s*===\s*0/);
  assert.match(fn, /fetchpriority=["']high["']/);
  assert.match(fn, /loading=["']lazy["']/);
});


test('shop head preloads the same-origin catalogue snapshot for faster mobile first render', () => {
  assert.match(index, /rel="preload"\s+as="fetch"\s+href="\/catalogue-snapshot\.json"/);
});
