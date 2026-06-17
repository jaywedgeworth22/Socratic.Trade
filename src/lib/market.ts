import { getEnrichmentProvider, type SymbolEnrichment } from "./data-providers";
import { getSymbolWebSignals } from "./web-sources";
import type { SymbolWebSignal } from "./web-sources";

/** How many freshly-disclosed "event" names may be unioned into the candidate set. */
const EVENT_CANDIDATE_RESERVE = Number(process.env.MARKET_SCAN_EVENT_RESERVE ?? 8);

/** A web signal worth pulling a below-cutoff name into the candidate set for. */
export function hasNotableWebSignal(sig?: SymbolWebSignal): boolean {
  if (!sig) return false;
  return (
    (sig.congress?.netSignal ?? 0) > 0 || // net congressional buying
    (typeof sig.insiderSentiment === "number" && sig.insiderSentiment >= 60) || // insider buying
    (typeof sig.shortVolumeRatio === "number" && sig.shortVolumeRatio >= 55) // elevated short pressure
  );
}
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

    // Read cached web-source signals for the WHOLE ranked universe (no network) so a
    // freshly-disclosed congressional/insider/short name that scored below the top-N
    // cutoff can still be pulled into the candidate set — "event candidate union".
    let allWebSignals: Record<string, SymbolWebSignal> = {};
    try {
      allWebSignals = getSymbolWebSignals(ranked.map((quote) => quote.symbol));
    } catch (error) {
      warnings.push(error instanceof Error ? `Web signals failed: ${error.message}` : "Web signals failed.");
    }
    const topCut = new Set(ranked.slice(0, quoteLimit).map((quote) => quote.symbol));
    const eventExtra = ranked
      .filter((quote) => !topCut.has(quote.symbol) && hasNotableWebSignal(allWebSignals[quote.symbol]))
      .slice(0, EVENT_CANDIDATE_RESERVE);
    // Keep the union within the enrichment cap by trimming the lowest-scored top names
    // to make room for the event names (so both get enriched).
    const keepTop = Math.max(0, quoteLimit - eventExtra.length);
    let topCandidates: MarketQuote[] = [...ranked.slice(0, keepTop), ...eventExtra];

    // Enrich the candidate set with news sentiment + fundamentals, then re-score & re-sort.
    const provider = getEnrichmentProvider();
    if (topCandidates.length > 0) {
      try {
        const enrichment = await provider.enrich(topCandidates.map((quote) => quote.symbol));
        topCandidates = topCandidates
          .map((quote) => {
            const extra = enrichment[quote.symbol];
            if (!extra) return quote;
            const enriched = applyEnrichment(quote, extra);
            const factorBreakdown = scoreFactors(enriched, weights);
            return { ...enriched, factorBreakdown, score: factorBreakdown.weightedTotal };
          })
          .sort((a, b) => b.score - a.score);
      } catch (error) {
        warnings.push(error instanceof Error ? `Enrichment failed: ${error.message}` : "Enrichment failed.");
      }
    }

    // Overlay backend web-source signals onto the candidates and STAMP their provenance
    // (so source attribution stays honest). senateTrades/insiderSentiment are filled only
    // when a keyed provider didn't already supply them. No network here.
    const overlaySources = new Set<string>();
    topCandidates = topCandidates.map((quote) => {
      const sig = allWebSignals[quote.symbol];
      if (!sig) return quote;
      const sources = { ...(quote.sources ?? {}) };
      let senateTrades = quote.senateTrades;
      if (senateTrades == null && typeof sig.congress?.netSignal === "number") {
        senateTrades = sig.congress.netSignal;
        sources.senateTrades = "congress";
        overlaySources.add("congress");
      }
      let insiderSentiment = quote.insiderSentiment;
      if (insiderSentiment == null && typeof sig.insiderSentiment === "number") {
        insiderSentiment = sig.insiderSentiment;
        sources.insiderSentiment = "sec-edgar";
        overlaySources.add("sec-edgar");
      }
      if (typeof sig.shortVolumeRatio === "number" && sig.shortVolumeRatio >= 55) overlaySources.add("finra");
      return {
        ...quote,
        senateTrades,
        insiderSentiment,
        evidenceBulletins: sig.bulletins.length > 0 ? sig.bulletins : quote.evidenceBulletins,
        sources
      };
    });

    // Fold enriched candidates back into the full set so quotesBySymbol carries sentiment/PE.
    const enrichedBySymbol = new Map(topCandidates.map((quote) => [quote.symbol, quote]));
    const mergedRanked = ranked.map((quote) => enrichedBySymbol.get(quote.symbol) ?? quote);

    const baseSource = provider.configured ? `${this.name}+${provider.name}` : this.name;
    const source = overlaySources.size > 0 ? `${baseSource}+${[...overlaySources].join("+")}` : baseSource;

    return {
      source,
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
    momentum: momentumScore(quote),
    value: valueScore(quote),
    quality: qualityScore(quote),
    volatility: volatilityScore(quote),
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

// Merge a provider enrichment record onto a screener quote (first-non-undefined wins,
// enrichment overriding the screener). Exported + exhaustive on purpose: every enriched
// field on SymbolEnrichment must be folded here or it silently never reaches the quote —
// the dashboard, scoring, and the agent prompt all read these off MarketQuote. This is the
// "merge in market.ts" half of the cross-file enrichment trap documented in CLAUDE.md.
export function applyEnrichment(quote: MarketQuote, extra: SymbolEnrichment): MarketQuote {
  return {
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
    fcfYield: extra.fcfYield ?? quote.fcfYield,
    debtToEquity: extra.debtToEquity ?? quote.debtToEquity,
    epsGrowth: extra.epsGrowth ?? quote.epsGrowth,
    senateTrades: extra.senateTrades ?? quote.senateTrades,
    sources: mergeSources(quote, extra)
  };
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

/** Position within the trailing 52-week range, 0 (at the low) … 100 (at the high). */
export function pricePosition52w(quote: MarketQuote): number | undefined {
  const { fiftyTwoWeekHigh: hi, fiftyTwoWeekLow: lo, price } = quote;
  if (typeof hi !== "number" || typeof lo !== "number" || hi <= lo) return undefined;
  return Math.round(clamp(((price - lo) / (hi - lo)) * 100));
}

function momentumScore(quote: MarketQuote): number {
  const intraday = ((quote.intradayChangePct + 5) / 10) * 100;
  // Blend in the 52-week price position when available: near the high reflects
  // sustained strength/breakout; near the low reflects weakness (or mean-reversion).
  const pos = pricePosition52w(quote);
  return typeof pos === "number" ? clamp(intraday * 0.6 + pos * 0.4) : clamp(intraday);
}

function volatilityScore(quote: MarketQuote): number {
  // Higher = steadier (less realized + systematic volatility). Beta, when available,
  // adjusts the intraday-only base so high-beta names score as riskier.
  let base = 100 - Math.abs(quote.intradayChangePct) * 12;
  if (typeof quote.beta === "number" && quote.beta > 0) {
    if (quote.beta > 1.5) base -= 15;
    else if (quote.beta > 1.1) base -= 6;
    else if (quote.beta < 0.8) base += 6;
  }
  return clamp(base);
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
        fcfYield: quote.fcfYield,
        debtToEquity: quote.debtToEquity,
        epsGrowth: quote.epsGrowth,
        senateTrades: quote.senateTrades,
        evidenceBulletins: quote.evidenceBulletins,
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
