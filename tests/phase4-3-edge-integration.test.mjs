import test from 'node:test';
import assert from 'node:assert/strict';

const endpoint = process.env.PHASE43_CHECKOUT_URL;
const token = process.env.PHASE43_USER_A_TOKEN;
const payloadText = process.env.PHASE43_NORMAL_CHECKOUT_PAYLOAD;

const enabled = Boolean(endpoint && token && payloadText);

async function post(body) {
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

test('authenticated quote ignores forged browser money', { skip: !enabled }, async () => {
  const base = JSON.parse(payloadText);
  const quote = await post({
    ...base,
    operation: 'quote',
    total: 1,
    deliveryFee: 0,
    discount: 99999,
    items: base.items.map((item) => ({ ...item, price: 1, productPrice: 1 })),
  });
  assert.equal(quote.status, 200);
  assert.equal(quote.body?.ok, true);
  assert.notEqual(Number(quote.body?.quote?.total), 1);
});

test('authenticated commit retry uses one idempotent order', { skip: !enabled }, async () => {
  const base = JSON.parse(payloadText);
  const key = crypto.randomUUID();
  const request = { ...base, operation: 'commit', idempotencyKey: key };
  const first = await post(request);
  const retry = await post(request);
  assert.equal(first.status, 200);
  assert.equal(retry.status, 200);
  assert.equal(first.body?.order?.orderId, retry.body?.order?.orderId);
});
