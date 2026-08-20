import type { CommitRequest, NormalizedCheckoutRequest, QuoteRequest } from './contracts.ts';
import type { RouteMeasurements, RoutingConfig } from './router.ts';

export type SupabaseRpcError = { code?: string; message?: string; status?: number };
export type SupabaseLikeClient = {
  auth: { getUser(token: string): Promise<{ data: { user: { id: string } | null }; error: unknown }> };
  rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: SupabaseRpcError | null; status?: number }>;
};

export class CheckoutDatabaseError extends Error {
  readonly code?: string;
  readonly status: number;
  readonly transient: boolean;

  constructor(code?: string, status = 503, transient = false) {
    super('Database checkout call failed.');
    this.name = 'CheckoutDatabaseError';
    this.code = code;
    this.status = status;
    this.transient = transient;
  }
}

export function createCheckoutDatabase(client: SupabaseLikeClient) {
  async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      const result = await client.rpc(name, args);
      if (result.error) {
        const status = result.status ?? result.error.status ?? 503;
        throw new CheckoutDatabaseError(
          result.error.code,
          status,
          status === 408 || status === 429 || status >= 500,
        );
      }
      return result.data;
    } catch (error) {
      if (error instanceof CheckoutDatabaseError) throw error;
      throw new CheckoutDatabaseError(undefined, 503, true);
    }
  }

  return {
    async verifyUser(accessToken: string): Promise<{ id: string }> {
      const result = await client.auth.getUser(accessToken);
      if (result.error || !result.data.user?.id) throw new Error('AUTH_REQUIRED');
      return { id: result.data.user.id };
    },

    async getRoutingConfig(): Promise<RoutingConfig> {
      const data = await rpc('p43_get_routing_config', {});
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw new CheckoutDatabaseError(undefined, 503);
      }
      const record = data as Record<string, unknown>;
      if (
        typeof record.origin !== 'object' || record.origin === null ||
        !Array.isArray(record.freeZones) ||
        typeof record.configHash !== 'string' ||
        typeof record.freeKmThreshold !== 'number' ||
        !Number.isFinite(record.freeKmThreshold)
      ) {
        throw new CheckoutDatabaseError(undefined, 503);
      }
      return data as RoutingConfig;
    },

    async quoteCheckout(
      userId: string,
      request: QuoteRequest,
      route: RouteMeasurements,
      configHash: string,
    ): Promise<unknown> {
      return rpc('p43_quote_checkout', {
        p_user_id: userId,
        p_request: request,
        p_route: route,
        p_config_hash: configHash,
      });
    },

    async commitCheckout(
      userId: string,
      idempotencyKey: string,
      request: CommitRequest,
      route: RouteMeasurements,
      configHash: string,
    ): Promise<unknown> {
      return rpc('p43_commit_checkout', {
        p_user_id: userId,
        p_idempotency_key: idempotencyKey,
        p_request: request,
        p_route: route,
        p_config_hash: configHash,
      });
    },
  };
}

export type CheckoutDatabase = ReturnType<typeof createCheckoutDatabase>;
