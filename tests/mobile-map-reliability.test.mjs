import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const modulePath = path.join(root, 'delivery-map.js');
const source = fs.readFileSync(modulePath, 'utf8');
const css = fs.readFileSync(path.join(root, 'phase3-fixes.css'), 'utf8');

async function importMapModule() {
  return import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`);
}

test('map module exposes mobile runtime policy and WebGL capability helper', async () => {
  const mod = await importMapModule();
  assert.equal(typeof mod.isWebGLSupported, 'function');
  assert.equal(typeof mod.getMapRuntimeProfile, 'function');
});

test('phone runtime caps pixel ratio and tile cache pressure', async () => {
  const { getMapRuntimeProfile } = await importMapModule();
  const profile = getMapRuntimeProfile({
    viewportWidth: 390,
    devicePixelRatio: 3,
    touchCapable: true,
    coarsePointer: true,
    reducedMotion: false
  });
  assert.equal(profile.constrained, true);
  assert.ok(profile.pixelRatio <= 1.5);
  assert.ok(profile.maxTileCacheSize <= 32);
  assert.ok(profile.maxTileCacheZoomLevels <= 2);
  assert.equal(profile.fadeDuration, 0);
  assert.equal(profile.dragRotate, false);
  assert.equal(profile.touchPitch, false);
});

test('desktop runtime keeps higher visual budget without changing interaction model', async () => {
  const { getMapRuntimeProfile } = await importMapModule();
  const profile = getMapRuntimeProfile({
    viewportWidth: 1440,
    devicePixelRatio: 2,
    touchCapable: false,
    coarsePointer: false,
    reducedMotion: false
  });
  assert.equal(profile.constrained, false);
  assert.ok(profile.pixelRatio <= 2);
  assert.equal(profile.dragRotate, false, 'delivery picker does not need map rotation');
});

test('map loader has bounded timeouts and failed loads can be retried', () => {
  assert.match(source, /MAP_LIBRARY_LOAD_TIMEOUT_MS/);
  assert.match(source, /MAP_RENDER_LOAD_TIMEOUT_MS/);
  assert.match(source, /Promise\.race|withTimeout/);
  assert.match(source, /mapLibreLoadPromise\s*=\s*null/);
  assert.match(source, /remove\(\)/);
});

test('map checks WebGL before initialization and handles lost/restored contexts', () => {
  assert.match(source, /isWebGLSupported\(/);
  assert.match(source, /webglcontextlost/);
  assert.match(source, /webglcontextrestored/);
  assert.match(source, /map\.on\(["']error["']/);
});

test('map resizes after modal visibility settles on mobile', () => {
  assert.match(source, /requestAnimationFrame/);
  assert.match(source, /visualViewport/);
  assert.match(source, /orientationchange/);
  assert.match(source, /map\.resize\(\)/);
});

test('geolocation uses a bounded fast attempt and a high-accuracy retry', () => {
  assert.match(source, /enableHighAccuracy:\s*false/);
  assert.match(source, /enableHighAccuracy:\s*true/);
  assert.match(source, /maximumAge/);
  assert.match(source, /timeout/);
});

test('phone map CSS uses dynamic viewport and touch-safe containment', () => {
  assert.match(css, /\.delivery-map-panel[\s\S]*100dvh/);
  assert.match(css, /\.delivery-map-canvas-wrap[\s\S]*touch-action/);
  assert.match(css, /overscroll-behavior/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
});
