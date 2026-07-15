import { fetchWithRetry } from "./data-providers";

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
  searchParams.set("apikey", apiKey);

  const normalizedEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  const base = normalizedEndpoint.startsWith("/v3") || normalizedEndpoint.startsWith("/v4")
    ? "https://financialmodelingprep.com/api"
    : "https://financialmodelingprep.com/stable";

  const url = `${base}${normalizedEndpoint}?${searchParams.toString()}`;

  try {
    const response = await fetchWithRetry(
      url,
      { method: "GET" },
      {
        service: options.service ?? "fmp",
        apiKey,
        suppressHealthStatuses: options.suppressStatuses ?? [402, 403],
        retries: 1,
      }
    );

    if (!response.ok) {
      if (response.status === 402 || response.status === 403) {
        console.warn(`[FMP] ${response.status} Restricted/Payment Required: ${normalizedEndpoint}`);
        return null;
      }
      throw new Error(`HTTP ${response.status} for ${normalizedEndpoint}`);
    }

    return await response.json() as T;
  } catch (err) {
    const scrubbedMsg = scrubUrl(err instanceof Error ? err.message : String(err), apiKey);
    console.error(`[FMP] Request failed for ${normalizedEndpoint}: ${scrubbedMsg}`);
    throw new Error(`FMP Fetch failed for ${normalizedEndpoint}`);
  }
}
