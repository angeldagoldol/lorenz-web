import test from 'node:test';
import assert from 'node:assert/strict';

const endpoint = process.env.PHASE43_CHECKOUT_URL;
const tokenA = process.env.PHASE43_USER_A_TOKEN;
const tokenB = process.env.PHASE43_USER_B_TOKEN;

function requireEnv() {
  if (!endpoint || !tokenA || !tokenB) {
    return false;
  }
  return true;
}

async function post(token, body) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      origin: process.env.PHASE43_ALLOWED_ORIGIN || 'https://lorenz-web-six.vercel.app',
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('independent final-stock checkout has exactly one winner', { skip: !requireEnv() }, async () => {
  const base = JSON.parse(process.env.PHASE43_FINAL_STOCK_PAYLOAD || 'null');
  assert.ok(base, 'PHASE43_FINAL_STOCK_PAYLOAD is required');
  const [a, b] = await Promise.all([
    post(tokenA, { ...base, idempotencyKey: crypto.randomUUID() }),
    post(tokenB, { ...base, idempotencyKey: crypto.randomUUID() }),
  ]);
  const successes = [a, b].filter((result) => result.status === 200 && result.body?.ok === true);
  const stockErrors = [a, b].filter((result) => result.body?.error?.code === 'INSUFFICIENT_STOCK');
  assert.equal(successes.length, 1);
  assert.equal(stockErrors.length, 1);
});

test('same idempotency key returns the same order under concurrent retry', { skip: !requireEnv() }, async () => {
  const base = JSON.parse(process.env.PHASE43_IDEMPOTENCY_PAYLOAD || 'null');
  assert.ok(base, 'PHASE43_IDEMPOTENCY_PAYLOAD is required');
  const key = crypto.randomUUID();
  const [a, b] = await Promise.all([
    post(tokenA, { ...base, idempotencyKey: key }),
    post(tokenA, { ...base, idempotencyKey: key }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.body?.order?.orderId, b.body?.order?.orderId);
});
