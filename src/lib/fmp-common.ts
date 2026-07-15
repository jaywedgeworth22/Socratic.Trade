import { apiKeyFingerprint, fetchWithRetry } from "./data-providers";
import {
  cancelUndispatchedProviderReservation,
  markProviderDispatchStarted,
  reserveProviderDispatch,
  settleProviderDispatch
} from "./db-provider-dispatch";
import { resolveProviderQuota } from "./provider-rate-limit";

export function getFmpApiKey(): string {
  const key = process.env.FMP_API_KEY;
  if (!key) {
    throw new Error("FMP_API_KEY is not defined in environment variables");
  }
  return key;
}

export function scrubUrl(url: string, apiKey?: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has("apikey")) {
      parsed.searchParams.set("apikey", "REDACTED");
    }
    return parsed.toString();
  } catch {
    if (apiKey) {
      return url.replaceAll(apiKey, "REDACTED");
    }
    return url;
  }
}

export async function requestFmp<T>(
  endpoint: string,
  params: Record<string, string | number> = {},
  options: {
    service?: string;
    suppressStatuses?: number[];
    userId?: string;
  } = {}
): Promise<T | null> {
  let apiKey: string;
  try {
    apiKey = getFmpApiKey();
  } catch (err) {
    console.error(`[FMP] API key check failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  const searchParams = new URLSearchParams();
  for (const [key, val] of Object.entries(params)) {
    searchParams.set(key, String(val));
  }
  const normalizedEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  const base = normalizedEndpoint.startsWith("/v3") || normalizedEndpoint.startsWith("/v4")
    ? "https://financialmodelingprep.com/api"
    : "https://financialmodelingprep.com/stable";

  const url = `${base}${normalizedEndpoint}?${searchParams.toString()}`;
  const operation = normalizedEndpoint.split("/").filter(Boolean).at(-1) ?? "request";
  const reservation = reserveProviderDispatch({
    provider: "fmp",
    operation: `capability-${operation}`,
    credentialRef: await apiKeyFingerprint(apiKey),
    userId: options.userId ?? "local",
    units: 1,
    estimatedCostUsd: 0,
    maxEstimatedCostUsdPer24h: 0,
    windows: (resolveProviderQuota("fmp") ?? []).map((window) => ({
      maxUnits: window.maxRequests,
      windowMs: window.windowMs
    }))
  });
  if (!reservation.admitted) {
    throw new Error(`FMP durable ${reservation.reason} reservation denied.`);
  }

  let dispatched = false;
  let settled = false;
  let classificationAttempted = false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6_000);

  try {
    const response = await fetchWithRetry(
      url,
      {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
        headers: { apikey: apiKey }
      },
      {
        service: options.service ?? "fmp",
        apiKey,
        userId: options.userId,
        suppressHealthStatuses: options.suppressStatuses ?? [402, 403],
        // One durable reservation represents exactly one external request.
        retries: 0,
        durableAttempt: {
          onDispatch: () => {
            markProviderDispatchStarted(reservation.attemptId);
            dispatched = true;
          },
          onResponse: (received) => {
            if (!received.ok) {
              classificationAttempted = true;
              settleProviderDispatch(reservation.attemptId, "failed", {
                outcomeCode: `http-${received.status}`
              });
              settled = true;
            }
          },
          onTransportError: (error) => {
            classificationAttempted = true;
            settleProviderDispatch(reservation.attemptId, "failed", {
              outcomeCode: error instanceof Error ? error.name : "transport-error"
            });
            settled = true;
          }
        }
      }
    );

    if (!response.ok) {
      if (response.status === 402 || response.status === 403) {
        console.warn(`[FMP] ${response.status} Restricted/Payment Required: ${normalizedEndpoint}`);
        return null;
      }
      throw new Error(`HTTP ${response.status} for ${normalizedEndpoint}`);
    }

    const payload = await response.json() as T;
    classificationAttempted = true;
    settleProviderDispatch(reservation.attemptId, "succeeded", {
      outcomeCode: "validated-json"
    });
    settled = true;
    return payload;
  } catch (err) {
    if (!dispatched) {
      cancelUndispatchedProviderReservation(reservation.attemptId, "pre-dispatch-failure");
    } else if (!settled && !classificationAttempted) {
      settleProviderDispatch(reservation.attemptId, "failed", {
        outcomeCode: err instanceof SyntaxError ? "invalid-json" : "response-failure"
      });
    }
    const scrubbedMsg = scrubUrl(err instanceof Error ? err.message : String(err), apiKey);
    console.error(`[FMP] Request failed for ${normalizedEndpoint}: ${scrubbedMsg}`);
    throw new Error(`FMP Fetch failed for ${normalizedEndpoint}`);
  } finally {
    clearTimeout(timeout);
  }
}
