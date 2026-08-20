import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCheckoutRouteMeasurements, routeRoadDistance } from './router.ts';

const origin = { latitude: 7.386874, longitude: 125.270799 };
const destination = { latitude: 7.45, longitude: 125.31, confirmed: true as const };

function response(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('accepts valid OSRM distance', async () => {
  const result = await routeRoadDistance(origin, destination, { fetchImpl: async () => response(200, { code: 'Ok', routes: [{ distance: 12500 }] }) });
  assert.deepEqual(result, { ok: true, roadDistanceKm: 12.5 });
});

test('retries one retryable failure only', async () => {
  let calls = 0;
  const result = await routeRoadDistance(origin, destination, {
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? response(503, {}) : response(200, { code: 'Ok', routes: [{ distance: 1000 }] });
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(result, { ok: true, roadDistanceKm: 1 });
});

test('does not retry permanent 400', async () => {
  let calls = 0;
  const result = await routeRoadDistance(origin, destination, { fetchImpl: async () => { calls += 1; return response(400, {}); } });
  assert.equal(calls, 1);
  assert.deepEqual(result, { ok: false });
});

test('uses trusted database freeKmThreshold instead of hard-coded 5km', async () => {
  let calls = 0;
  const result = await buildCheckoutRouteMeasurements({
    origin, freeKmThreshold: 10, configHash: 'hash',
    freeZones: [{ id: 'z1', name: 'Zone', latitude: 7.3, longitude: 125.2, radiusKm: 5 }],
  }, destination, {
    fetchImpl: async () => { calls += 1; return response(200, { code: 'Ok', routes: [{ distance: 7000 }] }); },
  });
  assert.equal(calls, 1, 'zone routes must not run when main route is inside configured free threshold');
  assert.equal(result.source, 'osrm');
});

test('main route failure returns authoritative fallback measurement', async () => {
  let calls = 0;
  const result = await buildCheckoutRouteMeasurements({ origin, freeKmThreshold: 5, configHash: 'h', freeZones: [] }, destination, {
    fetchImpl: async () => { calls += 1; return response(503, {}); },
  });
  assert.equal(calls, 2);
  assert.deepEqual(result, { source: 'fallback', main: { ok: false }, freeZones: [] });
});

test('free-zone route failure does not force global fallback', async () => {
  let calls = 0;
  const result = await buildCheckoutRouteMeasurements({
    origin, freeKmThreshold: 5, configHash: 'h', freeZones: [{ id: 'z1', name: 'Zone', latitude: 7.3, longitude: 125.2, radiusKm: 5 }],
  }, destination, {
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? response(200, { code: 'Ok', routes: [{ distance: 12000 }] }) : response(400, { code: 'NoRoute' });
    },
  });
  assert.equal(result.source, 'osrm');
  assert.deepEqual(result.freeZones, [{ id: 'z1', ok: false }]);
});
