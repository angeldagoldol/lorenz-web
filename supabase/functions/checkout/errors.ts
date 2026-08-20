export type CheckoutErrorCode =
  | 'INVALID_PRODUCT'
  | 'INVALID_VARIANT'
  | 'BUNDLE_UNAVAILABLE'
  | 'INSUFFICIENT_STOCK'
  | 'PROMO_NOT_FOUND'
  | 'PROMO_INACTIVE'
  | 'PROMO_EXPIRED'
  | 'PROMO_EXHAUSTED'
  | 'PROMO_MIN_SPEND'
  | 'PAYMENT_REFERENCE_REQUIRED'
  | 'PAYMENT_PROOF_OWNERSHIP'
  | 'IDEMPOTENCY_CONFLICT'
  | 'DELIVERY_CONFIG_CHANGED'
  | 'LOCATION_REQUIRED'
  | 'INVALID_REQUEST'
  | 'CHECKOUT_UNAVAILABLE'
  | 'AUTH_REQUIRED'
  | 'ORIGIN_NOT_ALLOWED'
  | 'METHOD_NOT_ALLOWED';

export type ClientError = { status: number; code: CheckoutErrorCode; message: string };

const SQLSTATE_ERRORS: Record<string, ClientError> = {
  P4301: { status: 409, code: 'INVALID_PRODUCT', message: 'A product in your cart is no longer available.' },
  P4302: { status: 409, code: 'INVALID_VARIANT', message: 'A selected product option is no longer available.' },
  P4303: { status: 409, code: 'BUNDLE_UNAVAILABLE', message: 'A bundle in your cart is no longer available.' },
  P4304: { status: 409, code: 'INSUFFICIENT_STOCK', message: 'One or more items no longer have enough stock.' },
  P4305: { status: 400, code: 'PROMO_NOT_FOUND', message: 'The promo code was not found.' },
  P4306: { status: 409, code: 'PROMO_INACTIVE', message: 'The promo code is not active.' },
  P4307: { status: 409, code: 'PROMO_EXPIRED', message: 'The promo code has expired.' },
  P4308: { status: 409, code: 'PROMO_EXHAUSTED', message: 'The promo code has reached its usage limit.' },
  P4309: { status: 400, code: 'PROMO_MIN_SPEND', message: 'The order does not meet the promo minimum spend.' },
  P4310: { status: 400, code: 'PAYMENT_REFERENCE_REQUIRED', message: 'A valid payment reference is required.' },
  P4311: { status: 403, code: 'PAYMENT_PROOF_OWNERSHIP', message: 'The payment proof is not in your account namespace.' },
  P4312: { status: 409, code: 'IDEMPOTENCY_CONFLICT', message: 'This checkout key was already used for different checkout details.' },
  P4313: { status: 409, code: 'DELIVERY_CONFIG_CHANGED', message: 'Delivery settings changed. Recalculating checkout is required.' },
  P4314: { status: 400, code: 'LOCATION_REQUIRED', message: 'A valid confirmed delivery pin is required.' },
  P4315: { status: 400, code: 'INVALID_REQUEST', message: 'The checkout request is invalid.' },
};

export function databaseErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as Record<string, unknown>).code;
  return typeof code === 'string' ? code : undefined;
}

export function isTransientDatabaseError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as Record<string, unknown>;
  if (record.transient === true) return true;
  const status = record.status;
  return typeof status === 'number' && (status === 408 || status === 429 || status >= 500);
}

export function mapDatabaseError(error: unknown): ClientError {
  const code = databaseErrorCode(error);
  if (code && SQLSTATE_ERRORS[code]) return SQLSTATE_ERRORS[code];
  return {
    status: 503,
    code: 'CHECKOUT_UNAVAILABLE',
    message: 'Checkout is temporarily unavailable. Please try again.',
  };
}
