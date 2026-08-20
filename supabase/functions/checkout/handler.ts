import {
  CheckoutRequestError,
  MAX_BODY_BYTES,
  normalizeCheckoutRequest,
  type CommitRequest,
  type QuoteRequest,
} from './contracts.ts';
import {
  databaseErrorCode,
  isTransientDatabaseError,
  mapDatabaseError,
} from './errors.ts';
import type { CheckoutDatabase } from './db.ts';
import {
  buildCheckoutRouteMeasurements,
  type RouterOptions,
  type RoutingConfig,
} from './router.ts';

export type HandlerDependencies = {
  database: CheckoutDatabase;
  allowedOrigins: Set<string>;
  routerOptions?: RouterOptions;
  logger?: (entry: Record<string, unknown>) => void;
};

function corsHeaders(origin: string | null, allowed: boolean): Record<string, string> {
  return {
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
    'access-control-max-age': '86400',
    vary: 'Origin',
    ...(origin && allowed ? { 'access-control-allow-origin': origin } : {}),
  };
}

function jsonResponse(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function errorResponse(
  code: string,
  status: number,
  message: string,
  headers: Record<string, string>,
): Response {
  return jsonResponse({ ok: false, error: { code, message } }, status, headers);
}

async function routeFor(config: RoutingConfig, request: QuoteRequest | CommitRequest, deps: HandlerDependencies) {
  return buildCheckoutRouteMeasurements(config, request.delivery.location, deps.routerOptions);
}

export async function handleRequest(request: Request, deps: HandlerDependencies): Promise<Response> {
  const startedAt = Date.now();
  const correlationId = crypto.randomUUID();
  const rawOrigin = request.headers.get('origin');
  const origin = rawOrigin ? rawOrigin.replace(/\/$/, '') : null;
  const originAllowed = !origin || deps.allowedOrigins.has(origin);
  const headers = {
    ...corsHeaders(origin, originAllowed),
    'x-checkout-request-id': correlationId,
  };

  let operation = 'unknown';
  let userId: string | undefined;
  let stableErrorCode: string | undefined;

  try {
    if (!originAllowed) {
      stableErrorCode = 'ORIGIN_NOT_ALLOWED';
      return errorResponse('ORIGIN_NOT_ALLOWED', 403, 'This origin is not allowed to use checkout.', headers);
    }

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') {
      stableErrorCode = 'METHOD_NOT_ALLOWED';
      return errorResponse('METHOD_NOT_ALLOWED', 405, 'Checkout accepts POST requests only.', headers);
    }

    const authorization = request.headers.get('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    if (!match) {
      stableErrorCode = 'AUTH_REQUIRED';
      return errorResponse('AUTH_REQUIRED', 401, 'Authentication is required to use checkout.', headers);
    }

    try {
      userId = (await deps.database.verifyUser(match[1])).id;
    } catch {
      stableErrorCode = 'AUTH_REQUIRED';
      return errorResponse('AUTH_REQUIRED', 401, 'Authentication is required to use checkout.', headers);
    }

    const contentLength = request.headers.get('content-length');
    if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) {
      stableErrorCode = 'INVALID_REQUEST';
      return errorResponse('INVALID_REQUEST', 413, 'Checkout request is too large.', headers);
    }

    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
      stableErrorCode = 'INVALID_REQUEST';
      return errorResponse('INVALID_REQUEST', 413, 'Checkout request is too large.', headers);
    }

    let rawInput: unknown;
    try {
      rawInput = JSON.parse(text);
    } catch {
      stableErrorCode = 'INVALID_REQUEST';
      return errorResponse('INVALID_REQUEST', 400, 'Checkout request must contain valid JSON.', headers);
    }

    let normalized: QuoteRequest | CommitRequest;
    try {
      normalized = normalizeCheckoutRequest(rawInput);
    } catch (error) {
      if (error instanceof CheckoutRequestError) {
        stableErrorCode = error.code;
        return errorResponse(error.code, 400, error.message, headers);
      }
      throw error;
    }

    operation = normalized.operation;
    let config = await deps.database.getRoutingConfig();
    let route = await routeFor(config, normalized, deps);

    if (normalized.operation === 'quote') {
      const quote = await deps.database.quoteCheckout(userId, normalized, route, config.configHash);
      return jsonResponse({ ok: true, quote }, 200, headers);
    }

    const commit = () => deps.database.commitCheckout(
      userId!,
      normalized.idempotencyKey,
      normalized,
      route,
      config.configHash,
    );

    try {
      const order = await commit();
      return jsonResponse({ ok: true, order }, 200, headers);
    } catch (error) {
      if (databaseErrorCode(error) === 'P4313') {
        config = await deps.database.getRoutingConfig();
        route = await routeFor(config, normalized, deps);
        const order = await commit();
        return jsonResponse({ ok: true, order }, 200, headers);
      }
      if (isTransientDatabaseError(error)) {
        const order = await commit();
        return jsonResponse({ ok: true, order }, 200, headers);
      }
      throw error;
    }
  } catch (error) {
    const mapped = mapDatabaseError(error);
    stableErrorCode = mapped.code;
    return errorResponse(mapped.code, mapped.status, mapped.message, headers);
  } finally {
    deps.logger?.({
      component: 'dagoldol-checkout',
      correlationId,
      operation,
      userRef: userId?.slice(0, 8),
      errorCode: stableErrorCode,
      durationMs: Date.now() - startedAt,
    });
  }
}
