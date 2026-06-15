import { getEnrichmentProvider } from "./data-providers";
import { DEFAULT_SCORING_WEIGHTS } from "./defaults";
import { normalizeSymbol } from "./money";
import type {
  EquityPosition,
  MarketDataProvider,
  MarketFactor,
  MarketFactorBreakdown,
  MarketQuote,
  MarketQuoteSummary,
  MarketScan,
  ScoringWeights
} from "./types";

const DEFAULT_SCAN_LIMIT = 30;
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const NASDAQ_SCREENER_URL = "https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=8000&offset=0";

type RawNasdaqRow = Record<string, unknown>;

let screenerCache:
  | {
      expiresAt: number;
      rows: RawNasdaqRow[];
      asOf?: string;
    }
  | undefined;

export async function scanMarket(
  symbols: string[],
  positions: EquityPosition[],
  scoringWeights: ScoringWeights = DEFAULT_SCORING_WEIGHTS
): Promise<MarketScan> {
  return nasdaqDelayedProvider.scan(symbols, positions, { scoringWeights, ttlMs: marketCacheTtlMs() });
}

export const nasdaqDelayedProvider: MarketDataProvider = {
  name: "nasdaq-delayed-screener",
  async scan(symbols, positions, options) {
    const allowed = new Set(symbols.map(normalizeSymbol));
    const weights = options?.scoringWeights ?? DEFAULT_SCORING_WEIGHTS;
    const warnings: string[] = [];
    let quotes: MarketQuote[] = [];
    let cached = false;

    try {
      const result = await fetchNasdaqScreener(options?.ttlMs ?? marketCacheTtlMs());
      cached = result.cached;
      quotes = result.rows
        .flatMap((row) => toMarketQuote(row, positions, this.name, result.asOf))
        .filter((quote) => allowed.has(quote.symbol));
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : "Market data request failed.");
    }

    const ranked = rankMarketQuotes(quotes, weights).map((quote) => ({ ...quote, cached }));
    const limit = Number(process.env.MARKET_SCAN_LIMIT ?? DEFAULT_SCAN_LIMIT);
    const quoteLimit = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_SCAN_LIMIT;
    let topCandidates: MarketQuote[] = ranked.slice(0, quoteLimit);

    // Enrich the top set with news sentiment + fundamentals, then re-score & re-sort.
    const provider = getEnrichmentProvider();
    if (!provider.configured) {
      warnings.push("News/fundamentals disabled (set FMP_API_KEY to enable sentiment and P/E).");
    } else if (topCandidates.length > 0) {
      try {
        const enrichment = await provider.enrich(topCandidates.map((quote) => quote.symbol));
        topCandidates = topCandidates
          .map((quote) => {
            const extra = enrichment[quote.symbol];
            if (!extra) return quote;
            const enriched: MarketQuote = {
              ...quote,
              sentiment: extra.sentiment ?? quote.sentiment,
              peRatio: extra.peRatio ?? quote.peRatio,
              headlines: extra.headlines ?? quote.headlines
            };
            const factorBreakdown = scoreFactors(enriched, weights);
            return { ...enriched, factorBreakdown, score: factorBreakdown.weightedTotal };
          })
          .sort((a, b) => b.score - a.score);
      } catch (error) {
        warnings.push(error instanceof Error ? `Enrichment failed: ${error.message}` : "Enrichment failed.");
      }
    }

    // Fold enriched candidates back into the full set so quotesBySymbol carries sentiment/PE.
    const enrichedBySymbol = new Map(topCandidates.map((quote) => [quote.symbol, quote]));
    const mergedRanked = ranked.map((quote) => enrichedBySymbol.get(quote.symbol) ?? quote);

    return {
      source: provider.configured ? `${this.name}+${provider.name}` : this.name,
      generatedAt: new Date().toISOString(),
      scannedSymbols: allowed.size,
      returnedQuotes: quotes.length,
      topCandidates,
      sectorBySymbol: sectorBySymbol(mergedRanked),
      quotesBySymbol: quotesBySymbol(mergedRanked),
      cacheTtlMs: options?.ttlMs ?? marketCacheTtlMs(),
      cached,
      warnings
    };
  }
};

export function rankMarketQuotes(quotes: MarketQuote[], weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS): MarketQuote[] {
  return quotes
    .map((quote) => {
      const factorBreakdown = scoreFactors(quote, weights);
      return { ...quote, factorBreakdown, score: factorBreakdown.weightedTotal };
    })
    .sort((a, b) => b.score - a.score);
}

export function scoreFactors(quote: MarketQuote, weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS): MarketFactorBreakdown {
  const factors: Record<MarketFactor, number> = {
    liquidity: liquidityScore(quote),
    momentum: clamp(((quote.intradayChangePct + 5) / 10) * 100),
    value: valueScore(quote),
    quality: qualityScore(quote),
    volatility: clamp(100 - Math.abs(quote.intradayChangePct) * 12),
    sentiment: clamp(quote.sentiment ?? 50),
    diversification: quote.positionMarketValue > 0 ? 45 : 80
  };
  const normalized = normalizeWeights(weights);
  const weightedTotal = (Object.keys(factors) as MarketFactor[]).reduce(
    (sum, factor) => sum + factors[factor] * normalized[factor],
    0
  );
  return { ...factors, weightedTotal: Math.round(weightedTotal * 100) / 100 };
}

export function mergeQuoteData(
  scan: MarketScan,
  quoteData: Record<string, { bid?: number; ask?: number; price?: number; asOf?: string; provider?: string }>
): MarketScan {
  const normalize = (quote: MarketQuote): MarketQuote => {
    const extra = quoteData[quote.symbol];
    if (!extra) return quote;
    return {
      ...quote,
      bid: positiveNumber(extra.bid) ?? quote.bid,
      ask: positiveNumber(extra.ask) ?? quote.ask,
      price: positiveNumber(extra.price) ?? quote.price,
      asOf: extra.asOf ?? quote.asOf,
      provider: extra.provider ?? quote.provider
    };
  };
  const topCandidates = scan.topCandidates.map(normalize);
  const quoteMap = Object.fromEntries(
    Object.values(scan.quotesBySymbol).map((quote) => {
      const extra = quoteData[quote.symbol];
      const merged: MarketQuoteSummary = {
        ...quote,
        bid: positiveNumber(extra?.bid) ?? quote.bid,
        ask: positiveNumber(extra?.ask) ?? quote.ask,
        price: positiveNumber(extra?.price) ?? quote.price,
        provider: extra?.provider ?? quote.provider,
        asOf: extra?.asOf ?? quote.asOf
      };
      return [quote.symbol, merged] as const;
    })
  );
  return {
    ...scan,
    source: Object.keys(quoteData).length > 0 ? `${scan.source}+robinhood-quotes` : scan.source,
    topCandidates,
    quotesBySymbol: quoteMap
  };
}

export function clearMarketCache(): void {
  screenerCache = undefined;
}

async function fetchNasdaqScreener(ttlMs: number): Promise<{ rows: RawNasdaqRow[]; asOf?: string; cached: boolean }> {
  const now = Date.now();
  if (screenerCache && screenerCache.expiresAt > now) {
    return { rows: screenerCache.rows, asOf: screenerCache.asOf, cached: true };
  }

  const response = await fetch(NASDAQ_SCREENER_URL, {
    cache: "no-store",
    headers: {
      accept: "application/json",
      "user-agent": "Mozilla/5.0"
    }
  });
  if (!response.ok) throw new Error(`Market data request failed with ${response.status}.`);

  const payload = await response.json();
  const rows = Array.isArray(payload?.data?.table?.rows) ? (payload.data.table.rows as RawNasdaqRow[]) : [];
  const asOf = typeof payload?.data?.asof === "string" ? payload.data.asof : undefined;
  screenerCache = { rows, asOf, expiresAt: now + ttlMs };
  return { rows, asOf, cached: false };
}

function toMarketQuote(row: RawNasdaqRow, positions: EquityPosition[], provider: string, asOf?: string): MarketQuote[] {
  const symbol = normalizeSymbol(String(row.symbol ?? ""));
  const price = number(row.lastsale);
  const intradayChangePct = percent(row.pctchange);
  const marketCap = number(row.marketCap);
  if (!symbol || !price) return [];

  const volume = number(row.volume);
  const netChange = number(row.netchange);
  const sector = text(row.sector);
  const industry = text(row.industry);
  const position = positions.find((p) => normalizeSymbol(p.symbol) === symbol);

  return [
    {
      symbol,
      price,
      volume,
      marketCap,
      intradayChangePct,
      netChange,
      sector: sector ?? position?.sector,
      industry: industry ?? position?.industry,
      positionMarketValue: position?.marketValue ?? 0,
      score: 0,
      provider,
      stale: true,
      asOf
    }
  ];
}

function normalizeWeights(weights: ScoringWeights): ScoringWeights {
  const sanitized = {
    liquidity: safeWeight(weights.liquidity),
    momentum: safeWeight(weights.momentum),
    value: safeWeight(weights.value),
    quality: safeWeight(weights.quality),
    volatility: safeWeight(weights.volatility),
    sentiment: safeWeight(weights.sentiment),
    diversification: safeWeight(weights.diversification)
  };
  const total = Object.values(sanitized).reduce((sum, value) => sum + value, 0);
  if (total <= 0) return normalizeWeights(DEFAULT_SCORING_WEIGHTS);
  return {
    liquidity: sanitized.liquidity / total,
    momentum: sanitized.momentum / total,
    value: sanitized.value / total,
    quality: sanitized.quality / total,
    volatility: sanitized.volatility / total,
    sentiment: sanitized.sentiment / total,
    diversification: sanitized.diversification / total
  };
}

function liquidityScore(quote: MarketQuote): number {
  if (quote.volume > 0) return clamp(((Math.log10(Math.max(quote.volume, 1)) - 4) / 4) * 100);
  if (quote.marketCap && quote.marketCap > 0) return clamp(((Math.log10(quote.marketCap) - 8) / 4) * 100);
  return 35;
}

function valueScore(quote: MarketQuote): number {
  // Prefer a real P/E signal when available; otherwise fall back to a market-cap heuristic.
  if (quote.peRatio && quote.peRatio > 0) {
    if (quote.peRatio <= 15) return 78;
    if (quote.peRatio <= 25) return 64;
    if (quote.peRatio <= 40) return 50;
    return 36;
  }
  if (!quote.marketCap || quote.marketCap <= 0) return 50;
  if (quote.marketCap >= 5_000_000_000) return 65;
  if (quote.marketCap >= 1_000_000_000) return 55;
  return 45;
}

function qualityScore(quote: MarketQuote): number {
  if (!quote.marketCap || quote.marketCap <= 0) return 50;
  if (quote.marketCap >= 10_000_000_000 && quote.volume >= 1_000_000) return 70;
  if (quote.marketCap >= 1_000_000_000) return 60;
  return 45;
}

function sectorBySymbol(quotes: MarketQuote[]): Record<string, string> {
  return Object.fromEntries(
    quotes
      .filter((quote) => quote.sector)
      .map((quote) => [quote.symbol, quote.sector!] as const)
  );
}

function quotesBySymbol(quotes: MarketQuote[]): Record<string, MarketQuoteSummary> {
  return Object.fromEntries(
    quotes.map((quote) => [
      quote.symbol,
      {
        symbol: quote.symbol,
        price: quote.price,
        bid: quote.bid,
        ask: quote.ask,
        sector: quote.sector,
        industry: quote.industry,
        score: quote.score,
        provider: quote.provider,
        asOf: quote.asOf,
        sentiment: quote.sentiment,
        peRatio: quote.peRatio
      }
    ])
  );
}

function marketCacheTtlMs(): number {
  const ttl = Number(process.env.MARKET_SCAN_CACHE_TTL_MS ?? DEFAULT_CACHE_TTL_MS);
  return Number.isFinite(ttl) && ttl >= 0 ? ttl : DEFAULT_CACHE_TTL_MS;
}

function safeWeight(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function number(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Number(String(value ?? "").replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function percent(value: unknown): number {
  return number(value);
}

function positiveNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
