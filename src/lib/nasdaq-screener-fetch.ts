import { fetchWithRetry } from "./data-providers";
import { BROWSER_UA } from "./web-sources/http";

/**
 * Shared Nasdaq delayed-screener fetch. Quote + calendar already use BROWSER_UA +
 * Origin/Referer + fetchWithRetry (2026-08-05). The screener was left on stub
 * "Mozilla/5.0" + `setTimeout(() => controller.abort(), 8000)` with no reason,
 * which Node/undici reports as "This operation was aborted" and never writes
 * the 5-minute cache. That is why prod receipts are `market_scan` with 0 quotes.
 */
export const NASDAQ_SCREENER_URL =
  "https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=8000&offset=0";

export const NASDAQ_SCREENER_TIMEOUT_MS = 15_000;
export const NASDAQ_SCREENER_ATTEMPTS = 2;
export const NASDAQ_SCREENER_TIMEOUT_MESSAGE =
  "Nasdaq delayed screener timed out waiting for api.nasdaq.com.";

export const NASDAQ_SCREENER_HEADERS = {
  Accept: "application/json,text/plain,*/*",
  "User-Agent": BROWSER_UA,
  Origin: "https://www.nasdaq.com",
  Referer: "https://www.nasdaq.com/"
} as const;

export function nasdaqScreenerUrl(exchange?: "nasdaq" | "nyse"): string {
  if (!exchange) return NASDAQ_SCREENER_URL;
  const url = new URL(NASDAQ_SCREENER_URL);
  url.searchParams.set("exchange", exchange);
  return url.toString();
}

function isScreenerTimeout(error: unknown, reason: unknown): boolean {
  const named =
    (reason instanceof Error && reason.message === NASDAQ_SCREENER_TIMEOUT_MESSAGE) ||
    (error instanceof Error && error.message === NASDAQ_SCREENER_TIMEOUT_MESSAGE);
  const abort = error instanceof Error && error.name === "AbortError";
  return named || abort;
}

export async function fetchNasdaqScreenerResponse(
  service: "nasdaq-delayed-screener" | "congress-nasdaq-screener",
  options?: { url?: string }
): Promise<Response> {
  const url = options?.url ?? NASDAQ_SCREENER_URL;
  let lastError: unknown;
  for (let attempt = 0; attempt < NASDAQ_SCREENER_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new Error(NASDAQ_SCREENER_TIMEOUT_MESSAGE));
    }, NASDAQ_SCREENER_TIMEOUT_MS);
    try {
      // fetch() resolves when headers arrive.  Clear the timer here so the
      // 8000-row JSON body cannot be aborted by the same 8s-style race.
      const response = await fetchWithRetry(
        url,
        {
          cache: "no-store",
          signal: controller.signal,
          headers: { ...NASDAQ_SCREENER_HEADERS }
        },
        { service, retries: 1 }
      );
      clearTimeout(timeout);
      return response;
    } catch (error) {
      const reason = controller.signal.reason;
      lastError = reason instanceof Error ? reason : error;
      if (!isScreenerTimeout(error, reason) || attempt === NASDAQ_SCREENER_ATTEMPTS - 1) {
        throw lastError;
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(NASDAQ_SCREENER_TIMEOUT_MESSAGE);
}
