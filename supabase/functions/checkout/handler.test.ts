import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from './handler.ts';
import type { CheckoutDatabase } from './db.ts';

const validDelivery = {
  name: 'Buyer', phone: '09171234567', address: 'Street', city: 'Davao City', postal: '8000', landmark: '',
  location: { latitude: 7.35, longitude: 125.30, confirmed: true },
};

function baseDb(overrides: Partial<CheckoutDatabase> = {}): CheckoutDatabase {
  return {
    verifyUser: async () => ({ id: '11111111-1111-4111-8111-111111111111' }),
    getRoutingConfig: async () => ({ origin: { latitude: 7.38, longitude: 125.27 }, freeKmThreshold: 5, freeZones: [], configHash: 'h1' }),
    quoteCheckout: async () => ({ total: 100 }),
    commitCheckout: async () => ({ orderId: 'ORD-1', total: 100 }),
    ...overrides,
  } as CheckoutDatabase;
}

const routeOk = async () => new Response(JSON.stringify({ code: 'Ok', routes: [{ distance: 1000 }] }), { status: 200 });

function req(body: unknown, extra: HeadersInit = {}) {
  return new Request('https://example.test/checkout', {
    method: 'POST',
    headers: { authorization: 'Bearer user-token', origin: 'https://lorenz-web-six.vercel.app', 'content-type': 'application/json', ...extra },
    body: JSON.stringify(body),
  });
}

test('missing bearer token returns AUTH_REQUIRED', async () => {
  const response = await handleRequest(new Request('https://example.test/checkout', { method: 'POST', body: '{}' }), {
    database: baseDb(), allowedOrigins: new Set(), routerOptions: { fetchImpl: routeOk },
  });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'AUTH_REQUIRED');
});

test('disallowed origin is rejected before checkout', async () => {
  const response = await handleRequest(req({}, { origin: 'https://evil.example' }), {
    database: baseDb(), allowedOrigins: new Set(['https://lorenz-web-six.vercel.app']), routerOptions: { fetchImpl: routeOk },
  });
  assert.equal(response.status, 403);
});

test('allowed OPTIONS returns CORS preflight', async () => {
  const response = await handleRequest(new Request('https://example.test/checkout', { method: 'OPTIONS', headers: { origin: 'https://lorenz-web-six.vercel.app' } }), {
    database: baseDb(), allowedOrigins: new Set(['https://lorenz-web-six.vercel.app']), routerOptions: { fetchImpl: routeOk },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://lorenz-web-six.vercel.app');
});

test('quote returns database canonical quote', async () => {
  const response = await handleRequest(req({ operation: 'quote', items: [{ kind: 'product', productId: 'p1', variant: '2', quantity: 1 }], delivery: validDelivery, total: 1 }), {
    database: baseDb(), allowedOrigins: new Set(['https://lorenz-web-six.vercel.app']), routerOptions: { fetchImpl: routeOk },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, quote: { total: 100 } });
});

test('commit retries same idempotency key after transient failure', async () => {
  const keys: string[] = [];
  let calls = 0;
  const database = baseDb({
    commitCheckout: async (_userId, key) => {
      keys.push(key);
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('transport'), { status: 503, transient: true });
      return { orderId: 'ORD-1' };
    },
  });
  const response = await handleRequest(req({
    operation: 'commit', idempotencyKey: '550e8400-e29b-41d4-a716-446655440000',
    items: [{ kind: 'product', productId: 'p1', variant: '2', quantity: 1 }], delivery: validDelivery,
    payment: { method: 'gcash', reference: 'REF', halfPayment: false },
  }), { database, allowedOrigins: new Set(['https://lorenz-web-six.vercel.app']), routerOptions: { fetchImpl: routeOk } });
  assert.equal(response.status, 200);
  assert.deepEqual(keys, ['550e8400-e29b-41d4-a716-446655440000', '550e8400-e29b-41d4-a716-446655440000']);
});

test('DELIVERY_CONFIG_CHANGED reloads config and reroutes once', async () => {
  let configs = 0;
  let commits = 0;
  const database = baseDb({
    getRoutingConfig: async () => {
      configs += 1;
      return { origin: { latitude: 7.38, longitude: 125.27 }, freeKmThreshold: configs === 1 ? 5 : 6, freeZones: [], configHash: `h${configs}` };
    },
    commitCheckout: async () => {
      commits += 1;
      if (commits === 1) throw Object.assign(new Error('changed'), { code: 'P4313', status: 409 });
      return { orderId: 'ORD-2' };
    },
  });
  const response = await handleRequest(req({
    operation: 'commit', idempotencyKey: '550e8400-e29b-41d4-a716-446655440000',
    items: [{ kind: 'product', productId: 'p1', variant: '2', quantity: 1 }], delivery: validDelivery,
    payment: { method: 'bank', reference: 'REF', halfPayment: false },
  }), { database, allowedOrigins: new Set(['https://lorenz-web-six.vercel.app']), routerOptions: { fetchImpl: routeOk } });
  assert.equal(response.status, 200);
  assert.equal(configs, 2);
  assert.equal(commits, 2);
});

test('unknown database errors are privacy-safe', async () => {
  const response = await handleRequest(req({ operation: 'quote', items: [{ kind: 'product', productId: 'p1', variant: '2', quantity: 1 }], delivery: validDelivery }), {
    database: baseDb({ quoteCheckout: async () => { throw Object.assign(new Error('SELECT secret'), { code: 'XX999' }); } }),
    allowedOrigins: new Set(['https://lorenz-web-six.vercel.app']), routerOptions: { fetchImpl: routeOk },
  });
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.error.code, 'CHECKOUT_UNAVAILABLE');
  assert.equal(JSON.stringify(body).includes('secret'), false);
});

test('invalid JSON returns safe INVALID_REQUEST', async () => {
  const response = await handleRequest(new Request('https://example.test/checkout', {
    method: 'POST',
    headers: { authorization: 'Bearer user-token', origin: 'https://lorenz-web-six.vercel.app', 'content-type': 'application/json' },
    body: '{not-json',
  }), {
    database: baseDb(), allowedOrigins: new Set(['https://lorenz-web-six.vercel.app']), routerOptions: { fetchImpl: routeOk },
  });
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'INVALID_REQUEST');
});
