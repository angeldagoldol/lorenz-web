import test from 'node:test';
import assert from 'node:assert/strict';
import { CheckoutRequestError, normalizeCheckoutRequest } from './contracts.ts';

const delivery = () => ({
  name: 'Buyer', phone: '09171234567', address: 'Street 1', city: 'Davao City', postal: '8000', landmark: '',
  location: { latitude: 7.35, longitude: 125.30, confirmed: true },
});

test('drops browser monetary authority fields', () => {
  const request = normalizeCheckoutRequest({
    operation: 'quote',
    items: [{ kind: 'product', productId: 'p1', variant: '2', quantity: 1, price: 1 }],
    delivery: delivery(), total: 1, deliveryFee: 0, discount: 99999, productPrice: 1,
  });
  assert.equal('total' in request, false);
  assert.equal('deliveryFee' in request, false);
  assert.equal('discount' in request, false);
  assert.equal('price' in request.items[0]!, false);
});

test('aggregates equivalent product lines deterministically', () => {
  const request = normalizeCheckoutRequest({
    operation: 'quote', delivery: delivery(),
    items: [
      { kind: 'product', productId: 'p1', variant: '2', quantity: 1 },
      { kind: 'product', productId: 'p1', variant: '2', quantity: 2 },
    ],
  });
  assert.deepEqual(request.items, [{ kind: 'product', productId: 'p1', variant: '2', quantity: 3 }]);
});

test('requires confirmed Philippine coordinates', () => {
  assert.throws(() => normalizeCheckoutRequest({
    operation: 'quote', items: [{ kind: 'bundle', bundleId: 'b1', quantity: 1 }],
    delivery: { ...delivery(), location: { latitude: 1, longitude: 1, confirmed: true } },
  }), (error: unknown) => error instanceof CheckoutRequestError && error.code === 'LOCATION_REQUIRED');
});

test('requires UUID idempotency key for commit', () => {
  assert.throws(() => normalizeCheckoutRequest({
    operation: 'commit', idempotencyKey: 'bad', items: [{ kind: 'bundle', bundleId: 'b1', quantity: 1 }],
    delivery: delivery(), payment: { method: 'gcash', reference: 'REF1', halfPayment: false },
  }), CheckoutRequestError);
});

test('normalizes commit payment without client monetary fields', () => {
  const request = normalizeCheckoutRequest({
    operation: 'commit', idempotencyKey: '550e8400-e29b-41d4-a716-446655440000',
    items: [{ kind: 'product', productId: 'p1', variant: '2', quantity: 1 }], delivery: delivery(),
    promoCode: ' save10 ', payment: { method: 'BANK', reference: ' R1 ', proofPath: null, halfPayment: true, amount: 1 },
    saveAddress: true, total: 1,
  });
  assert.equal(request.operation, 'commit');
  assert.equal(request.promoCode, 'SAVE10');
  assert.equal(request.payment.method, 'bank');
  assert.equal(request.payment.reference, 'R1');
  assert.equal(request.payment.halfPayment, true);
  assert.equal('amount' in request.payment, false);
  assert.equal('total' in request, false);
});
