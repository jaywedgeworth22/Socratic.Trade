import { getPolicy, resolveAlpacaMarketData, resolveApiKeyWithSource } from "./db";
import { getBrokerGateway } from "./broker";
import { DEFAULT_POLICY } from "./defaults";
import { AlpacaSnapshotEnrichmentProvider, fetchWithRetry } from "./data-providers";
import { fetchYahooFinanceQuote, fetchYahooFinanceQuotesBatch } from "./yahoo-finance";
import { normalizeSymbol } from "./money";
import type { BrokerQuote } from "./types";

/**
 * Helper to extract the first valid number from fields on an object.
 */
function firstNumber(obj: any, keys: string[]): number | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of keys) {
    const val = obj[k];
    if (typeof val === "number" && Number.isFinite(val)) return val;
    if (typeof val === "string") {
      const parsed = parseFloat(val);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

/**
 * Default max quote age for the cascade "accept and stop" threshold.
 *
 * MUST stay aligned with `DEFAULT_POLICY.maxQuoteAgeSec` (120s). A previous hard-coded
 * 16-minute window matched free delayed feeds (Tradier sandbox / Yahoo delayed ≈ 15 min),
 * so Level 1 accepted delayed quotes as "fresh" and never tried Alpaca/Yahoo real-time —
 * every strategy run then hit the 120s policy staleness gate and blocked/soft-blocked.
 */
export function cascadeFreshMaxAgeMs(maxQuoteAgeSec?: number | null): number {
  const fromPolicy =
    typeof maxQuoteAgeSec === "number" && Number.isFinite(maxQuoteAgeSec) && maxQuoteAgeSec > 0
      ? maxQuoteAgeSec
      : (DEFAULT_POLICY.maxQuoteAgeSec ?? 120);
  return Math.max(1, fromPolicy) * 1000;
}

/**
 * True when the quote's trade/asOf timestamp is within the cascade accept window.
 * Missing/unparseable asOf is NEVER treated as fresh — continue the cascade.
 */
export function isQuoteFresh(
  quote: { asOf?: string },
  nowMs: number,
  maxAgeMs: number = cascadeFreshMaxAgeMs()
): boolean {
  if (!quote.asOf) return false;
  const asOfMs = new Date(quote.asOf).getTime();
  if (Number.isNaN(asOfMs)) return false;
  const ageMs = nowMs - asOfMs;
  if (ageMs < 0) return true; // clock skew / future stamp — accept
  return ageMs <= maxAgeMs;
}

/**
 * Robust, redundant cascading quote resolver. Checks quote sources in series:
 * 1. Active Broker Gateway (Alpaca, Robinhood, Tradier, depending on active account)
 * 2. Alpaca Snapshots API
 * 3. Yahoo Finance Batch API
 * 4. Yahoo Finance Single Quote API
 * 5. ROIC.ai Profile API
 *
 * For each symbol, the cascade accepts the quote immediately if it is fresh (within
 * `policy.maxQuoteAgeSec`, default 120s — same bar as the policy staleness gate).
 * Delayed feeds (~15 min Tradier/Yahoo free) do NOT stop the cascade.
 * If all levels are exhausted without a quote under the freshness bar (market closed,
 * halt, etc.), returns the freshest quote found for each symbol.
 */
export async function fetchFreshQuotesCascade(
  symbols: string[],
  userId: string,
  accountNumber?: string
): Promise<Record<string, BrokerQuote>> {
  const nowMs = Date.now();
  const normalizedSymbols = Array.from(new Set(symbols.map(normalizeSymbol).filter(Boolean)));
  const result: Record<string, BrokerQuote> = {};

  if (normalizedSymbols.length === 0) return result;

  const isTest = process.env.NODE_ENV === "test";
  const allowExternal = !isTest || process.env.TEST_ALLOW_CASCADE_EXTERNAL === "1";

  // Track the best (freshest by asOf timestamp) quote found for each symbol across all levels
  const bestQuotes: Record<string, BrokerQuote> = {};
  let pendingSymbols = [...normalizedSymbols];

  const updateBestQuote = (symbol: string, quote: BrokerQuote) => {
    const existing = bestQuotes[symbol];
    if (!existing) {
      bestQuotes[symbol] = quote;
      return;
    }
    // Prefer newer asOf; if equal timestamps, prefer a provider that is not an explicit delayed tag
    const existingTime = existing.asOf ? new Date(existing.asOf).getTime() : 0;
    const newTime = quote.asOf ? new Date(quote.asOf).getTime() : 0;
    if (newTime > existingTime) {
      bestQuotes[symbol] = quote;
    }
  };

  // --- LEVEL 1: Active Broker Gateway ---
  let maxAgeMs = cascadeFreshMaxAgeMs();
  try {
    const policy = getPolicy(userId);
    maxAgeMs = cascadeFreshMaxAgeMs(policy.maxQuoteAgeSec);
    const activeAccountNum = accountNumber ?? policy.accountNumber;
    if (activeAccountNum && policy.activeBroker) {
      const gateway = getBrokerGateway(policy, userId);
      const brokerQuotes = await gateway.getEquityQuotes(activeAccountNum, pendingSymbols);
      for (const symbol of pendingSymbols) {
        const quote = brokerQuotes[symbol];
        if (quote) {
          const resolvedPrice = quote.price ?? (quote.bid && quote.ask ? (quote.bid + quote.ask) / 2 : undefined);
          if (typeof resolvedPrice === "number" && resolvedPrice > 0) {
            const normalizedQuote = {
              ...quote,
              price: resolvedPrice
            };
            updateBestQuote(symbol, normalizedQuote);
            if (isQuoteFresh(normalizedQuote, nowMs, maxAgeMs)) {
              result[symbol] = normalizedQuote;
            }
          }
        }
      }
      // Update pending symbols
      pendingSymbols = pendingSymbols.filter((s) => !result[s]);
    }
  } catch (error) {
    console.warn("[quotes-cascade] Level 1 (Broker) fetch failed or skipped:", error instanceof Error ? error.message : error);
  }

  // --- LEVEL 2: Alpaca Snapshots API ---
  if (pendingSymbols.length > 0 && allowExternal) {
    try {
      const alpacaData = resolveAlpacaMarketData(userId);
      if (alpacaData.apiKey && alpacaData.secretKey) {
        const provider = new AlpacaSnapshotEnrichmentProvider(alpacaData.apiKey, alpacaData.secretKey, alpacaData.source, userId);
        const enrichment = await provider.enrich(pendingSymbols);
        for (const symbol of pendingSymbols) {
          const data = enrichment[symbol];
          if (data) {
            const resolvedPrice = data.price ?? (data.bid && data.ask ? (data.bid + data.ask) / 2 : undefined);
            if (typeof resolvedPrice === "number" && resolvedPrice > 0) {
              const q: BrokerQuote = {
                symbol,
                price: resolvedPrice,
                bid: data.bid,
                ask: data.ask,
                volume: data.volume,
                asOf: data.asOf,
                provider: "alpaca-snapshot"
              };
              updateBestQuote(symbol, q);
              if (isQuoteFresh(q, nowMs, maxAgeMs)) {
                result[symbol] = q;
              }
            }
          }
        }
        pendingSymbols = pendingSymbols.filter((s) => !result[s]);
      }
    } catch (error) {
      console.warn("[quotes-cascade] Level 2 (Alpaca Snapshots) fetch failed:", error instanceof Error ? error.message : error);
    }
  }

  // --- LEVEL 3: Yahoo Finance Batch API ---
  if (pendingSymbols.length > 0 && allowExternal) {
    try {
      const yahooBatch = await fetchYahooFinanceQuotesBatch(pendingSymbols);
      for (const symbol of pendingSymbols) {
        const data = yahooBatch.get(symbol);
        if (data) {
          const resolvedPrice = data.price ?? (data.bid && data.ask ? (data.bid + data.ask) / 2 : undefined);
          if (typeof resolvedPrice === "number" && resolvedPrice > 0) {
            const q: BrokerQuote = {
              symbol,
              price: resolvedPrice,
              bid: data.bid,
              ask: data.ask,
              volume: data.volume,
              asOf: data.asOf,
              provider: "yahoo-finance-batch",
              syntheticBid: data.syntheticBid,
              syntheticAsk: data.syntheticAsk,
              syntheticSpread: data.syntheticSpread
            };
            updateBestQuote(symbol, q);
            if (isQuoteFresh(q, nowMs, maxAgeMs)) {
              result[symbol] = q;
            }
          }
        }
      }
      pendingSymbols = pendingSymbols.filter((s) => !result[s]);
    } catch (error) {
      console.warn("[quotes-cascade] Level 3 (Yahoo Finance Batch) fetch failed:", error instanceof Error ? error.message : error);
    }
  }

  // --- LEVEL 4: Yahoo Finance Single Quote API ---
  if (pendingSymbols.length > 0 && allowExternal) {
    try {
      const singleResults = await Promise.all(
        pendingSymbols.map(async (symbol) => [symbol, await fetchYahooFinanceQuote(symbol)] as const)
      );
      for (const [symbol, quote] of singleResults) {
        if (quote) {
          const resolvedPrice = quote.price ?? (quote.bid && quote.ask ? (quote.bid + quote.ask) / 2 : undefined);
          if (typeof resolvedPrice === "number" && resolvedPrice > 0) {
            const q: BrokerQuote = {
              symbol,
              price: resolvedPrice,
              bid: quote.bid,
              ask: quote.ask,
              volume: quote.volume,
              asOf: quote.asOf,
              provider: "yahoo-finance-single",
              syntheticBid: quote.syntheticBid,
              syntheticAsk: quote.syntheticAsk,
              syntheticSpread: quote.syntheticSpread
            };
            updateBestQuote(symbol, q);
            if (isQuoteFresh(q, nowMs, maxAgeMs)) {
              result[symbol] = q;
            }
          }
        }
      }
      pendingSymbols = pendingSymbols.filter((s) => !result[s]);
    } catch (error) {
      console.warn("[quotes-cascade] Level 4 (Yahoo Finance Single Chart) fetch failed:", error instanceof Error ? error.message : error);
    }
  }

  // --- LEVEL 5: ROIC.ai Profile API ---
  if (pendingSymbols.length > 0 && allowExternal) {
    try {
      const roic = resolveApiKeyWithSource("roic", userId);
      if (roic.key) {
        await Promise.all(
          pendingSymbols.map(async (symbol) => {
            try {
              const res = await fetchWithRetry(
                `https://api.roic.ai/v2/company/profile/${encodeURIComponent(symbol)}?apikey=${encodeURIComponent(roic.key!)}`,
                {},
                { service: "roic", keySource: roic.source, userId }
              );
              if (res.ok) {
                const profile = await res.json();
                const p = Array.isArray(profile) ? profile[0] : profile;
                if (p && typeof p === "object") {
                  const price = firstNumber(p, ["price"]);
                  if (typeof price === "number" && price > 0) {
                    const q: BrokerQuote = {
                      symbol,
                      price,
                      asOf: new Date().toISOString(),
                      provider: "roic"
                    };
                    updateBestQuote(symbol, q);
                    if (isQuoteFresh(q, nowMs, maxAgeMs)) {
                      result[symbol] = q;
                    }
                  }
                }
              }
            } catch (err) {
              console.warn(`[quotes-cascade] Level 5 (ROIC) fetch failed for ${symbol}:`, err);
            }
          })
        );
        pendingSymbols = pendingSymbols.filter((s) => !result[s]);
      }
    } catch (error) {
      console.warn("[quotes-cascade] Level 5 (ROIC) fetch failed:", error instanceof Error ? error.message : error);
    }
  }

  // --- FALLBACK ---
  // For any symbols that could not be resolved to a fresh quote (e.g. during market close / weekend),
  // fall back to the freshest quote found across any level (even if older than the freshness bar).
  for (const symbol of normalizedSymbols) {
    if (!result[symbol]) {
      const best = bestQuotes[symbol];
      if (best) {
        result[symbol] = best;
      }
    }
  }

  return result;
}
