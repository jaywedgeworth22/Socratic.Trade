import { getEnrichmentProvider, type SymbolEnrichment } from "./data-providers";
import { DEFAULT_SCORING_WEIGHTS } from "./defaults";
import { normalizeSymbol } from "./money";
import type {
  EnrichmentSources,
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
    const allowed = new Set([
      ...symbols.map(normalizeSymbol),
      ...positions.map((p) => normalizeSymbol(p.symbol))
    ]);
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
    // Enrichment covers the whole candidate slice (see maxSymbols), so every symbol that
    // can climb into the displayed set after re-sorting already has data.
    const provider = getEnrichmentProvider();
    if (topCandidates.length > 0) {
      try {
        const enrichment = await provider.enrich(topCandidates.map((quote) => quote.symbol));
        topCandidates = topCandidates
          .map((quote) => {
            const extra = enrichment[quote.symbol];
            if (!extra) return quote;
            const enriched: MarketQuote = {
              ...quote,
              companyName: extra.companyName ?? quote.companyName,
              sentiment: extra.sentiment ?? quote.sentiment,
              peRatio: extra.peRatio ?? quote.peRatio,
              headlines: extra.headlines ?? quote.headlines,
              analystRating: extra.analystRating ?? quote.analystRating,
              analystScore: extra.analystScore ?? quote.analystScore,
              analystBySource: extra.analystBySource ?? quote.analystBySource,
              sector: extra.sector ?? quote.sector,
              industry: extra.industry ?? quote.industry,
              volume: extra.volume && extra.volume > 0 ? extra.volume : quote.volume,
              dividendYield: extra.dividendYield ?? quote.dividendYield,
              eps: extra.eps ?? quote.eps,
              pbRatio: extra.pbRatio ?? quote.pbRatio,
              shortPercentOfFloat: extra.shortPercentOfFloat ?? quote.shortPercentOfFloat,
              beta: extra.beta ?? quote.beta,
              fiftyTwoWeekHigh: extra.fiftyTwoWeekHigh ?? quote.fiftyTwoWeekHigh,
              fiftyTwoWeekLow: extra.fiftyTwoWeekLow ?? quote.fiftyTwoWeekLow,
              insiderSentiment: extra.insiderSentiment ?? quote.insiderSentiment,
              sources: mergeSources(quote, extra)
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
  quoteData: Record<string, { bid?: number; ask?: number; price?: number; volume?: number; asOf?: string; provider?: string }>
): MarketScan {
  const normalize = (quote: MarketQuote): MarketQuote => {
    const extra = quoteData[quote.symbol];
    if (!extra) return quote;
    // Use broker/Yahoo volume if the screener didn't supply it (NASDAQ tableonly has no volume field).
    const usedExtraVolume = !!(extra.volume && extra.volume > 0);
    const sources: EnrichmentSources | undefined =
      usedExtraVolume && extra.provider
        ? { ...(quote.sources ?? {}), volume: extra.provider }
        : quote.sources;
    return {
      ...quote,
      bid: positiveNumber(extra.bid) ?? quote.bid,
      ask: positiveNumber(extra.ask) ?? quote.ask,
      price: positiveNumber(extra.price) ?? quote.price,
      volume: (usedExtraVolume ? extra.volume : undefined) ?? (quote.volume > 0 ? quote.volume : undefined) ?? 0,
      asOf: extra.asOf ?? quote.asOf,
      provider: extra.provider ?? quote.provider,
      sources
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
  for (const [rawSymbol, quote] of Object.entries(quoteData)) {
    const symbol = normalizeSymbol(rawSymbol);
    if (!symbol || quoteMap[symbol]) continue;
    const price = positiveNumber(quote.price);
    if (!price) continue;
    quoteMap[symbol] = {
      symbol,
      price,
      bid: positiveNumber(quote.bid),
      ask: positiveNumber(quote.ask),
      score: 0,
      provider: quote.provider,
      asOf: quote.asOf
    };
  }
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
  const companyName = text(row.name);
  const position = positions.find((p) => normalizeSymbol(p.symbol) === symbol);

  return [
    {
      symbol,
      companyName,
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

// Combine enrichment-supplied field sources with screener-supplied ones so each
// displayed cell can name the single provider its value came from.
function mergeSources(quote: MarketQuote, extra: SymbolEnrichment): EnrichmentSources {
  const sources: EnrichmentSources = { ...(extra.sources ?? {}) };
  // Fields the screener supplies when enrichment didn't override them.
  if (!sources.companyName && extra.companyName === undefined && quote.companyName) {
    sources.companyName = nasdaqDelayedProvider.name;
  }
  if (!sources.sector && extra.sector === undefined && quote.sector) sources.sector = nasdaqDelayedProvider.name;
  if (!sources.industry && extra.industry === undefined && quote.industry) sources.industry = nasdaqDelayedProvider.name;
  return sources;
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
  let base: number;
  if (quote.peRatio && quote.peRatio > 0) {
    base = quote.peRatio <= 15 ? 78 : quote.peRatio <= 25 ? 64 : quote.peRatio <= 40 ? 50 : 36;
  } else if (!quote.marketCap || quote.marketCap <= 0) {
    base = 50;
  } else {
    base = quote.marketCap >= 5_000_000_000 ? 65 : quote.marketCap >= 1_000_000_000 ? 55 : 45;
  }
  // Free-cash-flow yield is a real value signal independent of earnings multiples.
  if (typeof quote.fcfYield === "number") {
    if (quote.fcfYield >= 6) base += 12;
    else if (quote.fcfYield >= 3) base += 6;
    else if (quote.fcfYield < 0) base -= 8;
  }
  return clamp(base);
}

function qualityScore(quote: MarketQuote): number {
  let base: number;
  if (!quote.marketCap || quote.marketCap <= 0) base = 50;
  else if (quote.marketCap >= 10_000_000_000 && quote.volume >= 1_000_000) base = 70;
  else if (quote.marketCap >= 1_000_000_000) base = 60;
  else base = 45;
  // Leverage: lower debt/equity = higher quality. Providers report D/E as a ratio
  // (1.5) or a percentage (150); normalize to a ratio before bucketing.
  if (typeof quote.debtToEquity === "number") {
    const de = quote.debtToEquity > 10 ? quote.debtToEquity / 100 : quote.debtToEquity;
    if (de >= 0 && de <= 0.5) base += 10;
    else if (de <= 1.5) base += 3;
    else if (de > 3) base -= 10;
  }
  // Earnings growth (fractional YoY, e.g. 0.15 = +15%) is a durability signal.
  if (typeof quote.epsGrowth === "number") {
    if (quote.epsGrowth >= 0.15) base += 8;
    else if (quote.epsGrowth > 0) base += 3;
    else if (quote.epsGrowth < -0.1) base -= 8;
  }
  return clamp(base);
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
        companyName: quote.companyName,
        price: quote.price,
        bid: quote.bid,
        ask: quote.ask,
        sector: quote.sector,
        industry: quote.industry,
        score: quote.score,
        provider: quote.provider,
        asOf: quote.asOf,
        sentiment: quote.sentiment,
        peRatio: quote.peRatio,
        analystRating: quote.analystRating,
        analystScore: quote.analystScore,
        analystBySource: quote.analystBySource,
        dividendYield: quote.dividendYield,
        eps: quote.eps,
        pbRatio: quote.pbRatio,
        shortPercentOfFloat: quote.shortPercentOfFloat,
        beta: quote.beta,
        fiftyTwoWeekHigh: quote.fiftyTwoWeekHigh,
        fiftyTwoWeekLow: quote.fiftyTwoWeekLow,
        insiderSentiment: quote.insiderSentiment,
        sources: quote.sources
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
