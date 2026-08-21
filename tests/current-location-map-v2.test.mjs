import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const mapPath = path.join(root, 'delivery-map.js');
const source = fs.readFileSync(mapPath, 'utf8');
const scriptSource = fs.readFileSync(path.join(root, 'script.js'), 'utf8');

async function importMapModule() {
  return import(`${pathToFileURL(mapPath).href}?t=${Date.now()}-${Math.random()}`);
}

function position(latitude, longitude, accuracy = 50) {
  return { coords: { latitude, longitude, accuracy }, timestamp: Date.now() };
}

test('delivery map uses Leaflet instead of requiring MapLibre WebGL', () => {
  assert.match(source, /LEAFLET_VERSION\s*=\s*["']1\.9\.4["']/);
  assert.match(source, /LEAFLET_JS_URLS/);
  assert.match(source, /cdn\.jsdelivr\.net/);
  assert.match(source, /unpkg\.com/);
  assert.match(source, /L\.map\(/);
  assert.match(source, /L\.tileLayer\(/);
  assert.doesNotMatch(source, /new\s+maplibregl\.Map/);
  assert.doesNotMatch(source, /isWebGLSupported\(\)/);
});

test('map readiness does not wait for remote tiles to finish loading', () => {
  assert.match(source, /invalidateSize/);
  assert.match(source, /classList\.add\(["']is-ready["']\)/);
  assert.doesNotMatch(source, /MAP_RENDER_LOAD_TIMEOUT_MS/);
  assert.doesNotMatch(source, /map\.once\(["']load["']/);
});

test('current-location tracking starts a continuous fix before the one-shot request', async () => {
  const { startCurrentLocationTracking } = await importMapModule();
  assert.equal(typeof startCurrentLocationTracking, 'function');

  const calls = [];
  let clearId = null;
  const geolocation = {
    watchPosition(success) {
      calls.push('watch');
      queueMicrotask(() => success(position(14.5995, 120.9842, 35)));
      return 77;
    },
    getCurrentPosition(success) {
      calls.push('get');
      queueMicrotask(() => success(position(14.6, 120.985, 500)));
    },
    clearWatch(id) { clearId = id; }
  };

  const tracker = startCurrentLocationTracking({
    geolocation,
    permissions: { query: async () => ({ state: 'granted' }) },
    secureContext: true,
    maxTrackingMs: 50
  });

  const first = await tracker.firstPosition;
  assert.equal(calls[0], 'watch');
  assert.equal(first.coords.latitude, 14.5995);
  tracker.stop();
  assert.equal(clearId, 77);
});

test('the current-location control is not disabled while the map renderer is initializing', () => {
  const openFn = scriptSource.match(/async function openDeliveryMapPicker\(target\)\{[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(openFn, 'openDeliveryMapPicker should exist');
  assert.doesNotMatch(openFn, /deliveryMapCurrentLocationBtn\.disabled\s*=\s*true/);
  assert.match(openFn, /deliveryMapCurrentLocationBtn\.disabled\s*=\s*false/);
});

test('current-location button can acquire a position before the map controller is ready', () => {
  assert.match(scriptSource, /pendingCurrentLocationRequest/);
  assert.match(scriptSource, /getCurrentLocationSelection/);
  assert.doesNotMatch(scriptSource, /if\s*\(!deliveryMapController\)\s*return;/);
});
