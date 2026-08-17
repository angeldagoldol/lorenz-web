import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const mapPath = path.join(root, 'delivery-map.js');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'script.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'phase3-fixes.css'), 'utf8');

async function importMapModule() {
  return import(`${pathToFileURL(mapPath).href}?t=${Date.now()}-${Math.random()}`);
}

test('reverse geocoder derives a named nearby landmark suggestion', async () => {
  const { buildAddressFromNominatim } = await importMapModule();
  const result = buildAddressFromNominatim({
    name: 'San Pedro Chapel',
    display_name: 'San Pedro Chapel, Sampaguita Road, Barangay 5, Davao City, 8000, Philippines',
    address: {
      amenity: 'place_of_worship',
      road: 'Sampaguita Road',
      neighbourhood: 'Barangay 5',
      city: 'Davao City',
      postcode: '8000',
      country_code: 'ph'
    }
  });
  assert.equal(result.landmarkSuggestion, 'San Pedro Chapel');
});

test('reverse geocoder uses a neighbourhood as a fallback landmark without duplicating street/city', async () => {
  const { buildAddressFromNominatim } = await importMapModule();
  const result = buildAddressFromNominatim({
    display_name: 'Example Road, Matina, Davao City, Philippines',
    address: {
      road: 'Example Road',
      suburb: 'Matina',
      city: 'Davao City',
      country_code: 'ph'
    }
  });
  assert.equal(result.landmarkSuggestion, 'Matina');
});

test('profile and checkout expose map landmark suggestion controls', () => {
  for (const id of [
    'profile-landmark-suggestion',
    'profile-landmark-use-suggestion',
    'order-landmark-suggestion',
    'order-landmark-use-suggestion',
    'delivery-map-center-location'
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `${id} must exist`);
  }
  assert.match(html, /Use this location/);
});

test('map application preserves manual landmarks and only autofills empty fields', () => {
  assert.match(script, /applyLandmarkSuggestionToTarget/);
  assert.match(script, /if\s*\(!cleanAddressValue\(input\.value\)\)/);
  assert.match(script, /Use suggested landmark/);
  assert.match(script, /landmarkSuggestion/);
});

test('map controls have explicit locating state and center-current-location behavior', () => {
  assert.match(script, /setCurrentLocationButtonState/);
  assert.match(script, /deliveryMapCenterLocationBtn/);
  assert.match(script, /Center on my location/);
  assert.match(script, /aria-busy/);
});

test('mobile map actions are sticky and respect the bottom safe area', () => {
  assert.match(css, /\.delivery-map-actions[\s\S]*position:\s*sticky/);
  assert.match(css, /safe-area-inset-bottom/);
  assert.match(css, /\.landmark-suggestion-row/);
  assert.match(css, /\.map-autofilled/);
});
