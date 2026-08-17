import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const script = fs.readFileSync(new URL('../script.js', import.meta.url), 'utf8');
const generator = fs.readFileSync(new URL('../scripts/generate-public-catalogue.mjs', import.meta.url), 'utf8');

function sliceFunction(source, name) {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} must exist`);
  const signatureEnd = source.indexOf(')', start);
  const brace = source.indexOf('{', signatureEnd);
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

test('existing delivery pricing constants are unchanged', () => {
  assert.match(script, /const DELIVERY_FREE_KM_THRESHOLD = 5;/);
  assert.match(script, /const DELIVERY_RATE_PER_KM = 60;/);
  assert.match(script, /const DELIVERY_FALLBACK_FEE = 600;/);
  assert.doesNotMatch(script, /DELIVERY_(?:BASE|MINIMUM|STANDARD)_FEE\s*=\s*399/);
});

test('settings state includes an admin-configurable delivery origin', () => {
  for (const key of [
    'delivery_origin_address',
    'delivery_origin_latitude',
    'delivery_origin_longitude'
  ]) {
    assert.match(script, new RegExp(key), `${key} must be represented in runtime settings`);
  }

  const fn = sliceFunction(script, 'settingsFromRows');
  assert.match(fn, /delivery_origin_address/);
  assert.match(fn, /delivery_origin_latitude/);
  assert.match(fn, /delivery_origin_longitude/);
});

test('checkout routing prefers a valid saved owner origin and preserves hard-coded fallback', () => {
  assert.match(script, /SHOP_ORIGIN_ADDRESS/);
  assert.match(script, /SHOP_ORIGIN_FALLBACK_COORDS/);
  const fn = sliceFunction(script, 'getShopOriginCoords');
  assert.match(fn, /currentSettings|configured|delivery_origin/);
  assert.match(fn, /SHOP_ORIGIN_ADDRESS/);
  assert.match(fn, /SHOP_ORIGIN_FALLBACK_COORDS/);
});

test('admin Payment Settings exposes delivery-origin map controls and persists them', () => {
  for (const id of [
    'admin-delivery-origin-open',
    'admin-delivery-origin-card',
    'admin-delivery-origin-address',
    'admin-delivery-origin-latitude',
    'admin-delivery-origin-longitude'
  ]) {
    assert.match(script, new RegExp(id), `${id} must be rendered by Admin Settings`);
  }
  assert.match(script, /openDeliveryMapPicker\(["']admin-origin["']\)/);
  assert.match(script, /saveSetting\(["']delivery_origin_address["']/);
  assert.match(script, /saveSetting\(["']delivery_origin_latitude["']/);
  assert.match(script, /saveSetting\(["']delivery_origin_longitude["']/);
});

test('public settings snapshot includes owner origin for resilient checkout routing', () => {
  for (const key of [
    'delivery_origin_address',
    'delivery_origin_latitude',
    'delivery_origin_longitude'
  ]) {
    assert.match(generator, new RegExp(`['"]${key}['"]`), `${key} must be public snapshot allowlisted`);
  }
});
