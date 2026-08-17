import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve('/mnt/data/dagoldol-delivery-map-work');

async function importMapModule() {
  const file = path.join(root, 'delivery-map.js');
  assert.equal(fs.existsSync(file), true, 'delivery-map.js must exist');
  return import(`${pathToFileURL(file).href}?t=${Date.now()}`);
}

test('delivery map module exposes pure location helpers', async () => {
  const mod = await importMapModule();
  for (const name of [
    'isPhilippinesCoordinate',
    'normalizeSavedLocation',
    'buildAddressFromNominatim',
    'locationMatchesAddress'
  ]) {
    assert.equal(typeof mod[name], 'function', `${name} must be exported`);
  }
});

test('Philippine coordinate validation accepts PH and rejects outside coordinates', async () => {
  const { isPhilippinesCoordinate } = await importMapModule();
  assert.equal(isPhilippinesCoordinate(7.0731, 125.6128), true); // Davao
  assert.equal(isPhilippinesCoordinate(14.5995, 120.9842), true); // Manila
  assert.equal(isPhilippinesCoordinate(10.3157, 123.8854), true); // Cebu
  assert.equal(isPhilippinesCoordinate(35.6762, 139.6503), false); // Tokyo
  assert.equal(isPhilippinesCoordinate(NaN, 120), false);
});

test('saved location normalization is backward compatible and clamps shape', async () => {
  const { normalizeSavedLocation } = await importMapModule();
  assert.equal(normalizeSavedLocation(null), null);
  assert.equal(normalizeSavedLocation({ latitude: 7.0731, longitude: 125.6128 }).latitude, 7.0731);
  assert.equal(normalizeSavedLocation({ lat: 7.0731, lon: 125.6128 }).longitude, 125.6128);
  assert.equal(normalizeSavedLocation({ latitude: 35.6762, longitude: 139.6503 }), null);
});

test('Nominatim reverse result becomes Dagoldol address fields', async () => {
  const { buildAddressFromNominatim } = await importMapModule();
  const result = buildAddressFromNominatim({
    display_name: '123 Example Road, Barangay 1, Davao City, 8000, Philippines',
    address: {
      house_number: '123',
      road: 'Example Road',
      neighbourhood: 'Barangay 1',
      city: 'Davao City',
      postcode: '8000',
      country_code: 'ph'
    }
  });
  assert.deepEqual(result, {
    address: '123 Example Road, Barangay 1',
    city: 'Davao City',
    postal: '8000',
    displayName: '123 Example Road, Barangay 1, Davao City, 8000, Philippines'
  });
});

test('address-pin consistency detects manual edits that make a saved pin stale', async () => {
  const { locationMatchesAddress } = await importMapModule();
  const location = {
    latitude: 7.0731,
    longitude: 125.6128,
    addressSnapshot: {
      address: '123 Example Road',
      city: 'Davao City',
      postal: '8000'
    }
  };
  assert.equal(locationMatchesAddress(location, {
    address: '123 Example Road', city: 'Davao City', postal: '8000'
  }), true);
  assert.equal(locationMatchesAddress(location, {
    address: '999 Other Road', city: 'Davao City', postal: '8000'
  }), false);
});

test('main HTML contains reusable location map UI for profile and checkout', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  for (const id of [
    'delivery-map-modal',
    'delivery-map-canvas',
    'delivery-map-current-location',
    'delivery-map-confirm',
    'checkout-location-open',
    'checkout-location-current',
    'profile-location-open',
    'profile-location-current',
    'profile-address',
    'profile-city',
    'profile-postal',
    'profile-landmark'
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `${id} must exist`);
  }
});

test('map integration remains lazy and security policy permits only required map capabilities', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const vercel = fs.readFileSync(path.join(root, 'vercel.json'), 'utf8');
  assert.doesNotMatch(html, /maplibre-gl\.js/i, 'MapLibre must not be eagerly loaded by index.html');
  assert.match(vercel, /geolocation=\(self\)/);
  assert.match(vercel, /worker-src blob:/);
  assert.match(vercel, /tiles\.openfreemap\.org/);
  assert.match(vercel, /cdn\.jsdelivr\.net/);
});

test('checkout script persists location and routes by pin when available', () => {
  const script = fs.readFileSync(path.join(root, 'script.js'), 'utf8');
  assert.match(script, /checkoutPinnedLocation/);
  assert.match(script, /profilePinnedLocation/);
  assert.match(script, /calculateDeliveryFeeForCoords/);
  assert.match(script, /location:\s*serializePinnedLocation/);
  assert.match(script, /openDeliveryMapForCheckout/);
  assert.match(script, /openDeliveryMapForProfile/);
});
