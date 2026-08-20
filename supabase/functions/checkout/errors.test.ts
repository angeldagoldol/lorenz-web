import test from 'node:test';
import assert from 'node:assert/strict';
import { mapDatabaseError } from './errors.ts';

test('maps stock SQLSTATE to safe client error', () => {
  assert.deepEqual(mapDatabaseError({ code: 'P4304', message: 'raw inventory details' }), {
    status: 409, code: 'INSUFFICIENT_STOCK', message: 'One or more items no longer have enough stock.',
  });
});

test('does not leak unknown database errors', () => {
  const mapped = mapDatabaseError({ code: 'XX999', message: 'SELECT secret FROM payment_table' });
  assert.equal(mapped.code, 'CHECKOUT_UNAVAILABLE');
  assert.equal(mapped.message.includes('secret'), false);
});
