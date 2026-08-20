import type { DeliveryLocation } from './contracts.ts';

export type Coordinate = { latitude: number; longitude: number };
export type FreeZoneConfig = Coordinate & { id: string; name: string; radiusKm: number };
export type RoutingConfig = {
  origin: Coordinate;
  freeKmThreshold: number;
  freeZones: FreeZoneConfig[];
  configHash: string;
};
export type RouteResult = { ok: true; roadDistanceKm: number } | { ok: false };
export type RouteMeasurements = {
  source: 'osrm' | 'fallback';
  main: RouteResult;
  freeZones: Array<{ id: string; ok: boolean; roadDistanceKm?: number }>;
};

export type RouterOptions = {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
};

function finiteCoordinate(point: Coordinate): boolean {
  return Number.isFinite(point.latitude) && Number.isFinite(point.longitude);
}

function routeUrl(baseUrl: string, origin: Coordinate, destination: Coordinate): URL {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/route/v1/driving/${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}`;
  url.search = '?overview=false&alternatives=false&steps=false';
  return url;
}

export async function routeRoadDistance(
  origin: Coordinate,
  destination: Coordinate,
  options: RouterOptions = {},
): Promise<RouteResult> {
  if (!finiteCoordinate(origin) || !finiteCoordinate(destination)) return { ok: false };

  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? 'https://router.project-osrm.org';
  const timeoutMs = options.timeoutMs ?? 5_000;
  const url = routeUrl(baseUrl, origin, destination);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });

      if (response.ok) {
        const payload = await response.json() as { code?: unknown; routes?: Array<{ distance?: unknown }> };
        const distance = payload.routes?.[0]?.distance;
        if (
          payload.code === 'Ok' &&
          typeof distance === 'number' &&
          Number.isFinite(distance) &&
          distance >= 0
        ) {
          return { ok: true, roadDistanceKm: distance / 1_000 };
        }
        return { ok: false };
      }

      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      if (!retryable) return { ok: false };
    } catch {
      // Network/abort failures are retryable once.
    } finally {
      clearTimeout(timeout);
    }
  }

  return { ok: false };
}

export async function buildCheckoutRouteMeasurements(
  config: RoutingConfig,
  destination: DeliveryLocation,
  options: RouterOptions = {},
): Promise<RouteMeasurements> {
  if (!Number.isFinite(config.freeKmThreshold) || config.freeKmThreshold < 0) {
    throw new Error('Routing configuration has an invalid free-kilometre threshold.');
  }

  const main = await routeRoadDistance(config.origin, destination, options);
  if (!main.ok) {
    return { source: 'fallback', main, freeZones: [] };
  }

  if (main.roadDistanceKm <= config.freeKmThreshold || config.freeZones.length === 0) {
    return { source: 'osrm', main, freeZones: [] };
  }

  const freeZones = await Promise.all(config.freeZones.map(async (zone) => {
    const route = await routeRoadDistance(zone, destination, options);
    return route.ok
      ? { id: zone.id, ok: true, roadDistanceKm: route.roadDistanceKm }
      : { id: zone.id, ok: false };
  }));

  return { source: 'osrm', main, freeZones };
}
