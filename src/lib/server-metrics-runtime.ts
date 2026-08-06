export const SERVER_METRICS_CACHE_TTL_MS = 120_000;
export const SERVER_METRICS_FAILURE_RETRY_MS = 30_000;
export const SERVER_METRICS_MAX_STALE_MS = 10 * 60_000;

export interface ServerMetricsMetricValue {
  timestamp: number;
  value: number;
}

export type ServerMetricsConfigurationState = "configured" | "partial" | "missing";

export interface ServerMetricsPayload {
  isProd: boolean;
  usesLocalHost: boolean;
  degraded: boolean;
  stale: boolean;
  cacheAgeSeconds: number;
  configuration: {
    hetzner: ServerMetricsConfigurationState;
    coolify: ServerMetricsConfigurationState;
  };
  hostInfo: Record<string, unknown>;
  resources: unknown[];
  metrics: Record<string, ServerMetricsMetricValue[]>;
  asOf: string;
  error?: string;
  warnings?: string[];
}

export interface ServerMetricsCacheEntry {
  key: string;
  payload: ServerMetricsPayload;
  expiresAt: number;
  discardAt: number;
}

interface ServerMetricsRefreshInFlight {
  key: string;
  promise: Promise<ServerMetricsPayload>;
}

/** One process-local cache shared by the admin route. */
export const serverMetricsRuntime: {
  remoteCache?: ServerMetricsCacheEntry;
  remoteRefreshInFlight?: ServerMetricsRefreshInFlight;
} = {};

/** Test-only reset; route modules may export only route handlers/configuration in Next 16. */
export function resetServerMetricsCacheForTests(): void {
  serverMetricsRuntime.remoteCache = undefined;
  serverMetricsRuntime.remoteRefreshInFlight = undefined;
}
