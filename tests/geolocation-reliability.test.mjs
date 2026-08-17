import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const modulePath = path.join(root, 'delivery-map.js');

async function importMapModule() {
  return import(`${pathToFileURL(modulePath).href}?t=${Date.now()}-${Math.random()}`);
}

function position(latitude, longitude, accuracy) {
  return { coords: { latitude, longitude, accuracy }, timestamp: Date.now() };
}

function geoError(code, message = 'geolocation error') {
  return { code, message };
}

test('reliable geolocation exposes the resilience helpers', async () => {
  const mod = await importMapModule();
  assert.equal(typeof mod.getReliableCurrentPosition, 'function');
  assert.equal(typeof mod.getGeolocationPermissionState, 'function');
  assert.equal(typeof mod.getLocationFailureMessage, 'function');
});

test('permission state is read when the Permissions API supports geolocation', async () => {
  const { getGeolocationPermissionState } = await importMapModule();
  const permissions = { query: async ({ name }) => ({ state: name === 'geolocation' ? 'granted' : 'prompt' }) };
  assert.equal(await getGeolocationPermissionState(permissions), 'granted');
  assert.equal(await getGeolocationPermissionState(null), 'unknown');
});

test('a usable cached/network position returns immediately without starting an accuracy watch', async () => {
  const { getReliableCurrentPosition } = await importMapModule();
  let watchCalls = 0;
  const geolocation = {
    getCurrentPosition(success) { success(position(7.0731, 125.6128, 450)); },
    watchPosition() { watchCalls += 1; return 9; },
    clearWatch() {}
  };

  const result = await getReliableCurrentPosition({
    geolocation,
    permissions: { query: async () => ({ state: 'granted' }) },
    secureContext: true,
    acceptableFastAccuracyMeters: 1000,
    fastTimeoutMs: 20,
    watchTimeoutMs: 40
  });

  assert.equal(result.coords.latitude, 7.0731);
  assert.equal(watchCalls, 0);
});

test('after a fast timeout, watchPosition can deliver a slower GPS fix and is always cleared', async () => {
  const { getReliableCurrentPosition } = await importMapModule();
  let cleared = null;
  const geolocation = {
    getCurrentPosition(_success, error) { setTimeout(() => error(geoError(3, 'fast timeout')), 1); },
    watchPosition(success) {
      setTimeout(() => success(position(7.08, 125.61, 700)), 3);
      setTimeout(() => success(position(7.081, 125.611, 45)), 8);
      return 42;
    },
    clearWatch(id) { cleared = id; }
  };

  const result = await getReliableCurrentPosition({
    geolocation,
    permissions: { query: async () => ({ state: 'granted' }) },
    secureContext: true,
    targetAccuracyMeters: 80,
    fastTimeoutMs: 20,
    watchTimeoutMs: 30
  });

  assert.equal(result.coords.accuracy, 45);
  assert.equal(cleared, 42);
});

test('watchPosition returns the best position it received when the accuracy deadline expires', async () => {
  const { getReliableCurrentPosition } = await importMapModule();
  let cleared = false;
  const geolocation = {
    getCurrentPosition(_success, error) { error(geoError(2, 'not ready')); },
    watchPosition(success) {
      setTimeout(() => success(position(14.60, 120.98, 1800)), 2);
      setTimeout(() => success(position(14.601, 120.981, 600)), 5);
      return 7;
    },
    clearWatch() { cleared = true; }
  };

  const result = await getReliableCurrentPosition({
    geolocation,
    permissions: { query: async () => ({ state: 'prompt' }) },
    secureContext: true,
    targetAccuracyMeters: 80,
    fastTimeoutMs: 10,
    watchTimeoutMs: 15
  });

  assert.equal(result.coords.accuracy, 600);
  assert.equal(cleared, true);
});

test('a denied permission is not retried through a location watch', async () => {
  const { getReliableCurrentPosition } = await importMapModule();
  let watchCalls = 0;
  const geolocation = {
    getCurrentPosition() { throw new Error('should not run'); },
    watchPosition() { watchCalls += 1; return 1; },
    clearWatch() {}
  };

  await assert.rejects(
    getReliableCurrentPosition({
      geolocation,
      permissions: { query: async () => ({ state: 'denied' }) },
      secureContext: true,
      fastTimeoutMs: 10,
      watchTimeoutMs: 10
    }),
    error => error?.reason === 'permission_denied'
  );
  assert.equal(watchCalls, 0);
});

test('location failure copy gives actionable Windows and iPhone permission instructions', async () => {
  const { getLocationFailureMessage } = await importMapModule();
  const windows = getLocationFailureMessage(
    { code: 1, reason: 'permission_denied' },
    { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/151', permissionState: 'denied', secureContext: true }
  );
  assert.match(windows, /Privacy\s*&\s*security/i);
  assert.match(windows, /Location/i);

  const iphone = getLocationFailureMessage(
    { code: 1, reason: 'permission_denied' },
    { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) Version/18.0 Mobile Safari', permissionState: 'denied', secureContext: true }
  );
  assert.match(iphone, /Location Services/i);
  assert.match(iphone, /website|Safari/i);
});

test('an insecure context gets a specific HTTPS error before geolocation starts', async () => {
  const { getReliableCurrentPosition } = await importMapModule();
  await assert.rejects(
    getReliableCurrentPosition({
      geolocation: {},
      permissions: null,
      secureContext: false,
      fastTimeoutMs: 5,
      watchTimeoutMs: 5
    }),
    error => error?.reason === 'insecure_context'
  );
});

test('a reasonable watch fix settles quickly instead of waiting for the full GPS deadline', async () => {
  const { getReliableCurrentPosition } = await importMapModule();
  const geolocation = {
    getCurrentPosition(_success, error) { error(geoError(3, 'fast timeout')); },
    watchPosition(success) {
      setTimeout(() => success(position(7.09, 125.62, 550)), 2);
      return 18;
    },
    clearWatch() {}
  };

  const started = Date.now();
  const result = await getReliableCurrentPosition({
    geolocation,
    permissions: { query: async () => ({ state: 'granted' }) },
    secureContext: true,
    targetAccuracyMeters: 80,
    acceptableWatchAccuracyMeters: 1000,
    watchSettleMs: 6,
    fastTimeoutMs: 10,
    watchTimeoutMs: 45
  });
  const elapsed = Date.now() - started;

  assert.equal(result.coords.accuracy, 550);
  assert.ok(elapsed < 35, `reasonable fix should settle before deadline, elapsed=${elapsed}ms`);
});
