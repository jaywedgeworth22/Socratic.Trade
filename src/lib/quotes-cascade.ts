import { getPolicy, resolveAlpacaMarketData } from "./db";
import { getBrokerGateway } from "./broker";
import { AlpacaSnapshotEnrichmentProvider } from "./data-providers";
import { fetchYahooFinanceQuote, fetchYahooFinanceQuotesBatch } from "./yahoo-finance";
import { normalizeSymbol } from "./money";
import type { BrokerQuote } from "./types";

/**
 * Checks if a quote is fresh (timestamp is within 16 minutes of the current system time).
 */
function isQuoteFresh(quote: { asOf?: string }, nowMs: number): boolean {
  if (!quote.asOf) return false;
  const asOfMs = new Date(quote.asOf).getTime();
  if (Number.isNaN(asOfMs)) return false;
  // 16 minutes = 960,000 milliseconds
  return nowMs - asOfMs <= 16 * 60 * 1000;
}

/**
 * Robust, redundant cascading quote resolver. Checks quote sources in series:
 * 1. Active Broker Gateway (Alpaca, Robinhood, Tradier, depending on active account)
 * 2. Alpaca Snapshots API
 * 3. Yahoo Finance Batch API
 * 4. Yahoo Finance Single Quote API
 *
 * For each symbol, the cascade accepts the quote immediately if it is fresh (within 16 minutes).
 * If the quote is stale or missing, the cascade proceeds to the next level for that symbol.
 * If all levels are exhausted without finding a quote under 16 minutes old (e.g., when the market
 * is closed or the stock is halted), it returns the freshest quote found for each symbol.
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
    // Compare timestamps to find the newer one
    const existingTime = existing.asOf ? new Date(existing.asOf).getTime() : 0;
    const newTime = quote.asOf ? new Date(quote.asOf).getTime() : 0;
    if (newTime > existingTime) {
      bestQuotes[symbol] = quote;
    }
  };

  // --- LEVEL 1: Active Broker Gateway ---
  try {
    const policy = getPolicy(userId);
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
            if (isQuoteFresh(normalizedQuote, nowMs)) {
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
              if (isQuoteFresh(q, nowMs)) {
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
            if (isQuoteFresh(q, nowMs)) {
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
            if (isQuoteFresh(q, nowMs)) {
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

  // --- FALLBACK ---
  // For any symbols that could not be resolved to a fresh quote (e.g. during market close / weekend),
  // fall back to the freshest quote found across any level (even if older than 16 minutes).
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
