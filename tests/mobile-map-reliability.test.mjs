import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = fs.readFileSync(path.join(root, 'delivery-map.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'phase3-fixes.css'), 'utf8');
const vercel = fs.readFileSync(path.join(root, 'vercel.json'), 'utf8');

test('map renderer is Leaflet 1.9.4 and no longer depends on a WebGL context', () => {
  assert.match(source, /LEAFLET_VERSION\s*=\s*["']1\.9\.4["']/);
  assert.match(source, /L\.map\(/);
  assert.match(source, /L\.tileLayer\(/);
  assert.doesNotMatch(source, /maplibregl/i);
  assert.doesNotMatch(source, /webglcontextlost/i);
});

test('Leaflet loader retries a second CDN and clears failed scripts', () => {
  assert.match(source, /LEAFLET_JS_URLS/);
  assert.match(source, /cdn\.jsdelivr\.net/);
  assert.match(source, /unpkg\.com/);
  assert.match(source, /MAP_LIBRARY_LOAD_TIMEOUT_MS/);
  assert.match(source, /failed\.remove\(\)/);
});

test('map becomes ready before remote raster tiles finish', () => {
  assert.match(source, /classList\.add\(["']is-ready["']\)/);
  assert.match(source, /invalidateSize/);
  assert.match(source, /tileerror/);
  assert.doesNotMatch(source, /map\.once\(["']load["']/);
});

test('current location draws an accuracy circle and recenters the map', () => {
  assert.match(source, /L\.circle\(/);
  assert.match(source, /accuracy/);
  assert.match(source, /setView\(/);
  assert.match(source, /startCurrentLocationTracking/);
});

test('map resources and location tracking are released when the picker closes', () => {
  assert.match(source, /locationTracker\.stop\(\)/);
  assert.match(source, /tiles\.remove\(\)/);
  assert.match(source, /map\.remove\(\)/);
});

test('phone map CSS uses a smaller dynamic viewport and Leaflet-specific controls', () => {
  assert.match(css, /\.delivery-map-panel[\s\S]*100dvh/);
  assert.match(css, /\.delivery-map-canvas-wrap[\s\S]*42dvh/);
  assert.match(css, /\.leaflet-container/);
  assert.match(css, /\.dagoldol-leaflet-marker/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
});

test('security policy allows Leaflet fallback CDN and same-origin geolocation', () => {
  assert.match(vercel, /geolocation=\(self\)/);
  assert.match(vercel, /cdn\.jsdelivr\.net/);
  assert.match(vercel, /unpkg\.com/);
  assert.match(vercel, /tile\.openstreetmap\.org/);
});
