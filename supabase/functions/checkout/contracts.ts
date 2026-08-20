export const MAX_BODY_BYTES = 65_536;
export const MAX_ITEM_LINES = 100;
export const MAX_ITEM_QUANTITY = 10_000;

export type CheckoutOperation = 'quote' | 'commit';

export type ProductRequestLine = {
  kind: 'product';
  productId: string;
  variant: string;
  quantity: number;
};

export type BundleRequestLine = {
  kind: 'bundle';
  bundleId: string;
  quantity: number;
};

export type CheckoutRequestLine = ProductRequestLine | BundleRequestLine;

export type DeliveryLocation = {
  latitude: number;
  longitude: number;
  confirmed: true;
  accuracy?: number;
};

export type DeliveryDetails = {
  name: string;
  phone: string;
  address: string;
  city: string;
  postal: string;
  landmark: string;
  location: DeliveryLocation;
};

export type QuoteRequest = {
  operation: 'quote';
  items: CheckoutRequestLine[];
  delivery: DeliveryDetails;
  promoCode: string | null;
  halfPayment: boolean;
};

export type CommitRequest = {
  operation: 'commit';
  idempotencyKey: string;
  items: CheckoutRequestLine[];
  delivery: DeliveryDetails;
  promoCode: string | null;
  payment: {
    method: 'gcash' | 'bank';
    reference: string;
    proofPath: string | null;
    halfPayment: boolean;
  };
  saveAddress: boolean;
};

export type NormalizedCheckoutRequest = QuoteRequest | CommitRequest;

export class CheckoutRequestError extends Error {
  readonly code: 'INVALID_REQUEST' | 'LOCATION_REQUIRED';

  constructor(code: 'INVALID_REQUEST' | 'LOCATION_REQUIRED', message: string) {
    super(message);
    this.name = 'CheckoutRequestError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, name: string, maxLength: number): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    throw new CheckoutRequestError('INVALID_REQUEST', `${name} is required.`);
  }
  if (normalized.length > maxLength) {
    throw new CheckoutRequestError('INVALID_REQUEST', `${name} is too long.`);
  }
  return normalized;
}

function optionalString(value: unknown, name: string, maxLength: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new CheckoutRequestError('INVALID_REQUEST', `${name} is invalid.`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new CheckoutRequestError('INVALID_REQUEST', `${name} is too long.`);
  }
  return normalized;
}

function booleanValue(value: unknown, defaultValue = false): boolean {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'boolean') {
    throw new CheckoutRequestError('INVALID_REQUEST', 'Boolean field has an invalid value.');
  }
  return value;
}

function quantityValue(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_ITEM_QUANTITY
  ) {
    throw new CheckoutRequestError(
      'INVALID_REQUEST',
      `Item quantity must be an integer from 1 to ${MAX_ITEM_QUANTITY}.`,
    );
  }
  return value;
}

function normalizeItems(value: unknown): CheckoutRequestLine[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ITEM_LINES) {
    throw new CheckoutRequestError(
      'INVALID_REQUEST',
      `Checkout must contain between 1 and ${MAX_ITEM_LINES} item lines.`,
    );
  }

  const aggregated = new Map<string, CheckoutRequestLine>();

  for (const rawLine of value) {
    if (!isRecord(rawLine)) {
      throw new CheckoutRequestError('INVALID_REQUEST', 'Each checkout item must be an object.');
    }

    const kind = requiredString(rawLine.kind, 'Item kind', 16).toLowerCase();
    const quantity = quantityValue(rawLine.quantity);

    if (kind === 'product') {
      const productId = requiredString(rawLine.productId, 'Product ID', 120);
      const variant = requiredString(rawLine.variant, 'Product variant', 120);
      const key = `product\u0000${productId}\u0000${variant}`;
      const existing = aggregated.get(key) as ProductRequestLine | undefined;
      const total = (existing?.quantity ?? 0) + quantity;
      if (total > MAX_ITEM_QUANTITY) {
        throw new CheckoutRequestError('INVALID_REQUEST', 'Aggregated item quantity exceeds the allowed maximum.');
      }
      aggregated.set(key, { kind: 'product', productId, variant, quantity: total });
      continue;
    }

    if (kind === 'bundle') {
      const bundleId = requiredString(rawLine.bundleId, 'Bundle ID', 120);
      const key = `bundle\u0000${bundleId}`;
      const existing = aggregated.get(key) as BundleRequestLine | undefined;
      const total = (existing?.quantity ?? 0) + quantity;
      if (total > MAX_ITEM_QUANTITY) {
        throw new CheckoutRequestError('INVALID_REQUEST', 'Aggregated item quantity exceeds the allowed maximum.');
      }
      aggregated.set(key, { kind: 'bundle', bundleId, quantity: total });
      continue;
    }

    throw new CheckoutRequestError('INVALID_REQUEST', 'Item kind must be product or bundle.');
  }

  return [...aggregated.values()].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right))
  );
}

function normalizeDelivery(value: unknown): DeliveryDetails {
  if (!isRecord(value)) {
    throw new CheckoutRequestError('INVALID_REQUEST', 'Delivery details are required.');
  }

  const location = value.location;
  if (!isRecord(location) || location.confirmed !== true) {
    throw new CheckoutRequestError('LOCATION_REQUIRED', 'A confirmed delivery map pin is required.');
  }

  const latitude = location.latitude;
  const longitude = location.longitude;
  if (
    typeof latitude !== 'number' ||
    typeof longitude !== 'number' ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < 4 ||
    latitude > 21.5 ||
    longitude < 116 ||
    longitude > 127.5
  ) {
    throw new CheckoutRequestError(
      'LOCATION_REQUIRED',
      'Confirmed delivery pin is outside the supported Philippine map envelope.',
    );
  }

  let accuracy: number | undefined;
  if (location.accuracy !== undefined && location.accuracy !== null) {
    if (
      typeof location.accuracy !== 'number' ||
      !Number.isFinite(location.accuracy) ||
      location.accuracy < 0 ||
      location.accuracy > 100_000
    ) {
      throw new CheckoutRequestError('INVALID_REQUEST', 'Location accuracy is invalid.');
    }
    accuracy = Math.round(location.accuracy * 100) / 100;
  }

  return {
    name: requiredString(value.name, 'Delivery name', 200),
    phone: requiredString(value.phone, 'Delivery phone', 50),
    address: requiredString(value.address, 'Delivery address', 500),
    city: requiredString(value.city, 'Delivery city', 200),
    postal: requiredString(value.postal, 'Delivery postal code', 50),
    landmark: optionalString(value.landmark, 'Delivery landmark', 500),
    location: {
      latitude: Math.round(latitude * 1_000_000) / 1_000_000,
      longitude: Math.round(longitude * 1_000_000) / 1_000_000,
      confirmed: true,
      ...(accuracy === undefined ? {} : { accuracy }),
    },
  };
}

export function normalizeCheckoutRequest(input: unknown): NormalizedCheckoutRequest {
  if (!isRecord(input)) {
    throw new CheckoutRequestError('INVALID_REQUEST', 'Checkout request must be an object.');
  }

  const serialized = JSON.stringify(input);
  if (new TextEncoder().encode(serialized).byteLength > MAX_BODY_BYTES) {
    throw new CheckoutRequestError('INVALID_REQUEST', 'Checkout request is too large.');
  }

  const operation = requiredString(input.operation, 'Checkout operation', 16).toLowerCase();
  const items = normalizeItems(input.items);
  const delivery = normalizeDelivery(input.delivery);
  const promoCodeRaw = optionalString(input.promoCode, 'Promo code', 100);
  const promoCode = promoCodeRaw ? promoCodeRaw.toUpperCase() : null;

  if (operation === 'quote') {
    return {
      operation: 'quote',
      items,
      delivery,
      promoCode,
      halfPayment: booleanValue(input.halfPayment, false),
    };
  }

  if (operation !== 'commit') {
    throw new CheckoutRequestError('INVALID_REQUEST', 'Checkout operation must be quote or commit.');
  }

  if (
    typeof input.idempotencyKey !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.idempotencyKey)
  ) {
    throw new CheckoutRequestError('INVALID_REQUEST', 'A valid UUID idempotencyKey is required.');
  }

  if (!isRecord(input.payment)) {
    throw new CheckoutRequestError('INVALID_REQUEST', 'Payment details are required for commit.');
  }

  const method = requiredString(input.payment.method, 'Payment method', 20).toLowerCase();
  if (method !== 'gcash' && method !== 'bank') {
    throw new CheckoutRequestError('INVALID_REQUEST', 'Payment method must be gcash or bank.');
  }

  return {
    operation: 'commit',
    idempotencyKey: input.idempotencyKey.toLowerCase(),
    items,
    delivery,
    promoCode,
    payment: {
      method,
      reference: requiredString(input.payment.reference, 'Payment reference', 200),
      proofPath: optionalString(input.payment.proofPath, 'Payment proof path', 1024) || null,
      halfPayment: booleanValue(input.payment.halfPayment, false),
    },
    saveAddress: booleanValue(input.saveAddress, false),
  };
}
