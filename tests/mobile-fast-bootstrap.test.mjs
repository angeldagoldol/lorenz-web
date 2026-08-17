import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

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
  let brace = source.indexOf('{', signatureEnd);
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

test('static LiquidChrome fallback is rich, layered, and non-animated on shop and My Info', () => {
  assert.match(phase3, /DAGOLDOL STATIC LIQUID CHROME/);
  assert.match(style1, /DAGOLDOL STATIC LIQUID CHROME/);
  for (const css of [phase3, style1]) {
    assert.match(css, /\.liquid-chrome-bg\.liquid-chrome-static/);
    const gradients = (css.match(/radial-gradient\(/g) || []).length;
    assert.ok(gradients >= 4, 'static fallback should use at least four radial gradients');
    assert.doesNotMatch(css.match(/DAGOLDOL STATIC LIQUID CHROME[\s\S]*$/)?.[0] || '', /@keyframes|animation\s*:/);
  }
});

test('mobile critical CSS, safe-area viewport, and connection warm-up hints ship from the head', () => {
  assert.match(index, /viewport-fit=cover/);
  assert.match(index1, /viewport-fit=cover/);
  assert.match(index, /rel="preconnect"\s+href="https:\/\/rvrjkfbenramappteuae\.supabase\.co"/);
  assert.match(index, /rel="dns-prefetch"\s+href="\/\/rvrjkfbenramappteuae\.supabase\.co"/);
  assert.match(index, /rel="preconnect"\s+href="https:\/\/cdn\.jsdelivr\.net"/);
  assert.match(index, /href="\.\/phase2-fixes\.css\?v=3\.3\.0"/);
  assert.match(index, /href="\.\/phase3-fixes\.css\?v=3\.3\.0"/);
  assert.match(index, /src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@2"\s+defer/);
  assert.match(index, /src="script\.js\?v=3\.3\.0"\s+defer/);
});

test('mobile static path still exits before OGL module download', () => {
  const fn = sliceFunction(liquid, 'createLiquidChrome');
  const staticIndex = fn.indexOf('shouldUseStaticBackground()');
  const oglIndex = fn.indexOf('loadOglModule()');
  assert.ok(staticIndex >= 0 && oglIndex > staticIndex, 'static mobile decision must happen before OGL import');
});

test('My Info contact cards can shrink and wrap at 320px without horizontal overflow', () => {
  assert.match(style1, /\.contact__grid[\s\S]*min-width:\s*0/);
  assert.match(style1, /\.contact-card__value[\s\S]*overflow-wrap:\s*anywhere/);
});
