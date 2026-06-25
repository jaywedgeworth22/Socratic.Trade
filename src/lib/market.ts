import { shareScanRefs } from "./congress-share";
import { getEnrichmentProvider, type SymbolEnrichment } from "./data-providers";
import type { GroupedDailyBar } from "./market-signals/massive";
import { getSymbolWebSignals, setTechnicalWatchlist } from "./web-sources";
import type { SymbolWebSignal } from "./web-sources";
import { clearFundHoldingsCache, fetchBlackRockHoldingSymbols, isBlackRockHoldingUniverse } from "./fund-holdings";

/** A web signal worth pulling a below-cutoff name into the candidate set for. */
export function hasNotableWebSignal(sig?: SymbolWebSignal): boolean {
  return outlierInterestScore(sig) > 0;
}

export function outlierInterestScore(sig?: SymbolWebSignal): number {
  if (!sig) return 0;
  // Congress: require at least 2 distinct members buying AND net >= 2 (more buys than sells).
  // Single-member disclosures are too thin to justify overriding the scan score cutoff.
  const congressNotable =
    (sig.congress?.buyCount ?? 0) >= 2 &&
    (sig.congress?.netSignal ?? 0) >= 2;
  const congressScore = congressNotable
    ? 70 + Math.min(25, (sig.congress?.netSignal ?? 0) * 5 + (sig.congress?.buyCount ?? 0) * 2)
    : 0;
  // App A analytics boost (the "Trends" composite): a strong dollar-weighted net buy flow, a cluster
  // buy (many members → same ticker), or multiple distinct members + high-track-record members can
  // surface a name even when the scraped per-member netSignal is thin. Only present when
  // CONGRESS_ANALYTICS_ENABLED is on; absent → 0 → no behavior change (back-compatible).
  const analyticsScore = congressAnalyticsScore(sig.congressAnalytics);
  const insiderScore = typeof sig.insiderSentiment === "number" && sig.insiderSentiment >= 60
    ? sig.insiderSentiment
    : 0;
  const shortScore = typeof sig.shortVolumeRatio === "number" && sig.shortVolumeRatio >= 55
    ? Math.min(90, sig.shortVolumeRatio)
    : 0;
  const technicalScore = sig.technical?.direction === "bullish" && (sig.technical?.score ?? 0) >= 70
    ? sig.technical.score
    : 0;
  return Math.max(congressScore, analyticsScore, insiderScore, shortScore, technicalScore);
}

/** 0–100 outlier weight from App A's aggregate congressional analytics; 0 unless there is net buying. */
export function congressAnalyticsScore(a?: SymbolWebSignal["congressAnalytics"]): number {
  if (!a) return 0;
  const netBuying = (a.netSentiment ?? 0) > 0 || (a.netFlowUsd ?? 0) > 0;
  if (!netBuying) return 0; // net selling / neutral is not a long-side outlier
  const flowBoost = (a.netFlowUsd ?? 0) > 0 ? Math.min(20, Math.log10(Math.max(1, a.netFlowUsd ?? 0)) * 3) : 0;
  const clusterBoost = a.cluster ? 15 : 0;
  const memberBoost = (a.memberCount ?? 0) >= 2 ? Math.min(10, (a.memberCount ?? 0) * 2) : 0;
  const qualityBoost = a.topMemberScore ? Math.min(15, a.topMemberScore * 0.15) : 0;
  return Math.min(95, 50 + flowBoost + clusterBoost + memberBoost + qualityBoost);
}
import { DEFAULT_SCORING_WEIGHTS } from "./defaults";
import { INDEX_UNIVERSES, isIndexMemberSymbol } from "./index-universes";
import { normalizeSymbol } from "./money";
import {
  DEFAULT_MARKET_SCAN_CANDIDATE_LIMIT,
  DEFAULT_MARKET_SCAN_OUTLIER_RESERVE,
  normalizeMarketScanCandidateLimit,
  normalizeMarketScanOutlierReserve
} from "./scan-settings";
import { fetchYahooFinanceQuote, type YahooFinanceQuote } from "./yahoo-finance";
import type {
  EnrichmentSources,
  EquityPosition,
  IndexUniverse,
  MarketDataProvider,
  MarketFactor,
  MarketFactorBreakdown,
  MarketQuote,
  MarketQuoteSummary,
  MarketScan,
  ScoringWeights
} from "./types";

const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const NASDAQ_SCREENER_URL = "https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=8000&offset=0";

type RawNasdaqRow = Record<string, unknown>;
type NasdaqExchange = "nasdaq" | "nyse";

// Nasdaq screener is a public, unauthenticated endpoint — no user API key is
// consumed, so this single shared cache is safe to serve to all users.
let screenerCache = new Map<string, { expiresAt: number; rows: RawNasdaqRow[]; asOf?: string }>();

export async function scanMarket(
  symbols: string[],
  positions: EquityPosition[],
  scoringWeights: ScoringWeights = DEFAULT_SCORING_WEIGHTS,
  userId?: string,
  dynamicUniverses: IndexUniverse[] = [],
  scanOptions: { candidateLimit?: number; outlierReserve?: number } = {}
): Promise<MarketScan> {
  const scan = await nasdaqDelayedProvider.scan(symbols, positions, {
    scoringWeights,
    ttlMs: marketCacheTtlMs(),
    userId,
    dynamicUniverses,
    candidateLimit: scanOptions.candidateLimit,
    outlierReserve: scanOptions.outlierReserve
  });
  // Forward the candidate company refs to congress.trade (App A) so it can avoid spending the shared
  // FMP quota. No-op unless CONGRESS_TRADE_TOKEN + CONGRESS_SHARE_ENABLED are set; per-symbol
  // throttled and fully self-guarded, so it never delays or breaks a scan. Fire-and-forget.
  void shareScanRefs(scan);
  return scan;
}

export const nasdaqDelayedProvider: MarketDataProvider = {
  name: "nasdaq-delayed-screener",
  async scan(symbols, positions, options) {
    const allowed = new Set([
      ...symbols.map(normalizeSymbol).filter(Boolean),
      ...positions.map((p) => normalizeSymbol(p.symbol)).filter(Boolean)
    ]);
    const dynamicUniverses = Array.from(new Set(options?.dynamicUniverses ?? []));
    const weights = options?.scoringWeights ?? DEFAULT_SCORING_WEIGHTS;
    const warnings: string[] = [];
    let quotes: MarketQuote[] = [];
    let cached = false;
    let breadthPct: number | undefined;
    const universeSources = new Set<string>();

    try {
      const result = await fetchNasdaqScreener(options?.ttlMs ?? marketCacheTtlMs());
      cached = result.cached;
      const allQuotes = result.rows.flatMap((row) => toMarketQuote(row, positions, this.name, result.asOf));
      quotes = allQuotes.filter((quote) => allowed.has(quote.symbol));

      const dynamicResult = await loadDynamicUniverseQuotes({
        dynamicUniverses,
        allQuotes,
        positions,
        providerName: this.name,
        ttlMs: options?.ttlMs ?? marketCacheTtlMs()
      });
      quotes = uniqueQuotes([...quotes, ...dynamicResult.quotes]);
      dynamicResult.warnings.forEach((warning) => warnings.push(warning));
      dynamicResult.sources.forEach((source) => universeSources.add(source));
      if (dynamicResult.cached) cached = true;

      const returnedSymbols = new Set(quotes.map((quote) => quote.symbol));
      const customSymbolsMissingFromScreener = Array.from(allowed)
        .filter((symbol) => !returnedSymbols.has(symbol) && !isIndexMemberSymbol(symbol));
      if (customSymbolsMissingFromScreener.length > 0) {
        const quoteOnly = await fetchQuoteOnlyMarketQuotes(customSymbolsMissingFromScreener, positions);
        quotes = [...quotes, ...quoteOnly.quotes];
        warnings.push(...quoteOnly.warnings);
      }
      // Market breadth: % of the full screener that's advancing today — a free,
      // market-wide risk-on/risk-off gauge (computed from data we already fetched).
      const moved = allQuotes.filter((q) => q.intradayChangePct !== 0);
      if (moved.length >= 20) {
        breadthPct = Math.round((moved.filter((q) => q.intradayChangePct > 0).length / moved.length) * 100);
      }
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : "Market data request failed.");
    }

    const ranked = rankMarketQuotes(quotes, weights).map((quote) => ({ ...quote, cached }));
    const candidateLimit = normalizeMarketScanCandidateLimit(options?.candidateLimit, envNumber("MARKET_SCAN_LIMIT", DEFAULT_MARKET_SCAN_CANDIDATE_LIMIT));
    const outlierReserve = normalizeMarketScanOutlierReserve(options?.outlierReserve, candidateLimit, envNumber("MARKET_SCAN_EVENT_RESERVE", DEFAULT_MARKET_SCAN_OUTLIER_RESERVE));

    // Read cached web-source signals for the WHOLE ranked universe (no network) so a
    // freshly-disclosed congressional/insider/short name that scored below the top-N
    // cutoff can still be pulled into the candidate set — "event candidate union".
    let allWebSignals: Record<string, SymbolWebSignal> = {};
    try {
      allWebSignals = getSymbolWebSignals(ranked.map((quote) => quote.symbol));
    } catch (error) {
      warnings.push(error instanceof Error ? `Web signals failed: ${error.message}` : "Web signals failed.");
    }
    const topCut = new Set(ranked.slice(0, candidateLimit).map((quote) => quote.symbol));
    const eventExtra = ranked
      .filter((quote) => !topCut.has(quote.symbol) && hasNotableWebSignal(allWebSignals[quote.symbol]))
      .sort((a, b) => {
        const signalDelta = outlierInterestScore(allWebSignals[b.symbol]) - outlierInterestScore(allWebSignals[a.symbol]);
        return signalDelta !== 0 ? signalDelta : b.score - a.score;
      })
      .slice(0, outlierReserve);
    // Keep the union within the enrichment cap by trimming the lowest-scored top names
    // to make room for the event names (so both get enriched).
    const keepTop = Math.max(0, candidateLimit - eventExtra.length);
    let topCandidates: MarketQuote[] = [...ranked.slice(0, keepTop), ...eventExtra];

    // Enrich the candidate set with news sentiment + fundamentals, then re-score & re-sort.
    const provider = getEnrichmentProvider(options?.userId);
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
      // Bar-based technical read (TradingView push or in-house computed). Feeds momentumScore.
      if (sig.technical) overlaySources.add(sig.technical.source);
      const overlaid: MarketQuote = {
        ...quote,
        senateTrades,
        insiderSentiment,
        technicalScore: sig.technical?.score ?? quote.technicalScore,
        technicalDirection: sig.technical?.direction ?? quote.technicalDirection,
        technicalSignals: sig.technical?.signals ?? quote.technicalSignals,
        evidenceBulletins: sig.bulletins.length > 0 ? sig.bulletins : quote.evidenceBulletins,
        sources
      };
      // Recompute the score: positioning depends on senateTrades/insiderSentiment and momentum
      // now blends technicalScore — both filled by the overlay — so a freshly-disclosed
      // smart-money name or a strong technical signal ranks up deterministically.
      const factorBreakdown = scoreFactors(overlaid, weights);
      return { ...overlaid, factorBreakdown, score: factorBreakdown.weightedTotal };
    });
    // Re-sort so the positioning/technical lift actually reorders the displayed candidates.
    topCandidates = topCandidates.sort((a, b) => b.score - a.score);

    // Cross-sectional sector relative strength: each name's intraday move vs the average
    // move of its sector among the candidates. Lets the agent (and UI) see who is leading
    // or lagging its own sector today, not just the tape overall. Computed in-house.
    const sectorAgg = new Map<string, { sum: number; count: number }>();
    for (const quote of topCandidates) {
      if (!quote.sector || !Number.isFinite(quote.intradayChangePct)) continue;
      const agg = sectorAgg.get(quote.sector) ?? { sum: 0, count: 0 };
      agg.sum += quote.intradayChangePct;
      agg.count += 1;
      sectorAgg.set(quote.sector, agg);
    }
    topCandidates = topCandidates.map((quote) => {
      const agg = quote.sector ? sectorAgg.get(quote.sector) : undefined;
      // Need at least one peer in the sector for a relative read to be meaningful.
      if (!agg || agg.count < 2 || !Number.isFinite(quote.intradayChangePct)) return quote;
      const sectorAvg = agg.sum / agg.count;
      return { ...quote, sectorRelStrength: Math.round((quote.intradayChangePct - sectorAvg) * 100) / 100 };
    });

    // Record the candidate set as the technical watchlist so the in-house "computed"
    // producer (TECHNICAL_SOURCE=computed) knows which names to pull OHLC for next refresh.
    // Cheap local write; a no-op consumer in TradingView push mode.
    if (topCandidates.length > 0) {
      try {
        setTechnicalWatchlist(topCandidates.map((quote) => quote.symbol));
      } catch {
        /* watchlist persistence is best-effort; never block a scan on it */
      }
    }

    // Fold enriched candidates back into the full set so quotesBySymbol carries sentiment/PE.
    const enrichedBySymbol = new Map(topCandidates.map((quote) => [quote.symbol, quote]));
    const mergedRanked = ranked.map((quote) => enrichedBySymbol.get(quote.symbol) ?? quote);

    const baseSource = provider.configured ? `${this.name}+${provider.name}` : this.name;
    const source = appendUniqueSources(
      overlaySources.size > 0 ? `${baseSource}+${[...overlaySources].join("+")}` : baseSource,
      [...universeSources]
    );

    return {
      source,
      generatedAt: new Date().toISOString(),
      scannedSymbols: new Set([...allowed, ...quotes.map((quote) => quote.symbol)]).size,
      returnedQuotes: quotes.length,
      candidateLimit,
      outlierReserve,
      outlierCandidateCount: eventExtra.length,
      breadthPct,
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
    positioning: positioningScore(quote),
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
    source: brokerQuoteSource(scan.source, quoteData),
    topCandidates,
    quotesBySymbol: quoteMap
  };
}

export function mergeGroupedBarData(scan: MarketScan, bars: GroupedDailyBar[], provider = "massive-vwap"): MarketScan {
  const bySymbol = new Map(bars.map((bar) => [normalizeSymbol(bar.ticker), bar]));
  let applied = false;

  const withVwap = <T extends MarketQuote | MarketQuoteSummary>(quote: T): T => {
    const bar = bySymbol.get(quote.symbol);
    const vwap = positiveNumber(bar?.vwap);
    if (!vwap) return quote;
    applied = true;
    return {
      ...quote,
      vwap,
      sources: { ...(quote.sources ?? {}), vwap: provider }
    };
  };
  const topCandidates = scan.topCandidates.map(withVwap);
  const quotesBySymbol = Object.fromEntries(
    Object.entries(scan.quotesBySymbol).map(([symbol, quote]) => [symbol, withVwap(quote)] as const)
  );

  return {
    ...scan,
    source: applied ? appendUniqueSources(scan.source, [provider]) : scan.source,
    topCandidates,
    quotesBySymbol
  };
}

function brokerQuoteSource(
  baseSource: string,
  quoteData: Record<string, { provider?: string }>
): string {
  const providerSources = Array.from(
    new Set(
      Object.values(quoteData)
        .map((quote) => quote.provider?.trim().toLowerCase())
        .filter((provider): provider is string => Boolean(provider))
        .map((provider) => (provider.endsWith("-quotes") ? provider : `${provider}-quotes`))
    )
  ).sort();
  const additions = providerSources.length === 0 && Object.keys(quoteData).length > 0 ? ["broker-quotes"] : providerSources;
  return appendUniqueSources(baseSource, additions);
}

function appendUniqueSources(baseSource: string, additions: string[]): string {
  const parts = baseSource
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  const seen = new Set(parts.map((part) => part.toLowerCase()));
  for (const addition of additions) {
    if (seen.has(addition)) continue;
    parts.push(addition);
    seen.add(addition);
  }
  return parts.join("+");
}

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

export function clearMarketCache(): void {
  screenerCache = new Map();
  clearFundHoldingsCache();
}

async function fetchNasdaqScreener(ttlMs: number, exchange?: NasdaqExchange): Promise<{ rows: RawNasdaqRow[]; asOf?: string; cached: boolean }> {
  const now = Date.now();
  const cacheKey = exchange ?? "all";
  const cached = screenerCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return { rows: cached.rows, asOf: cached.asOf, cached: true };
  }

  const response = await fetch(nasdaqScreenerUrl(exchange), {
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
  screenerCache.set(cacheKey, { rows, asOf, expiresAt: now + ttlMs });
  return { rows, asOf, cached: false };
}

function toMarketQuote(row: RawNasdaqRow, positions: EquityPosition[], provider: string, asOf?: string): MarketQuote[] {
  const symbol = normalizeMarketDataSymbol(String(row.symbol ?? ""));
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

async function loadDynamicUniverseQuotes(input: {
  dynamicUniverses: IndexUniverse[];
  allQuotes: MarketQuote[];
  positions: EquityPosition[];
  providerName: string;
  ttlMs: number;
}): Promise<{ quotes: MarketQuote[]; warnings: string[]; sources: string[]; cached: boolean }> {
  const quotes: MarketQuote[] = [];
  const warnings: string[] = [];
  const sources: string[] = [];
  let cached = false;

  for (const universe of input.dynamicUniverses) {
    const config = INDEX_UNIVERSES[universe];
    if (!config?.dynamicSource) continue;
    if (config.dynamicSource === "nasdaq-screener") {
      quotes.push(...input.allQuotes);
      sources.push(`${universe}-universe`);
      continue;
    }
    if (config.dynamicSource === "nasdaq-exchange") {
      const exchange = config.exchange;
      if (!exchange) continue;
      try {
        const result = await fetchNasdaqScreener(input.ttlMs, exchange);
        cached = cached || result.cached;
        quotes.push(...result.rows.flatMap((row) => toMarketQuote(row, input.positions, input.providerName, result.asOf)));
        sources.push(`${universe}-universe`);
      } catch (error) {
        warnings.push(error instanceof Error ? `${config.label} universe failed: ${error.message}` : `${config.label} universe failed.`);
      }
      continue;
    }
    if (isBlackRockHoldingUniverse(universe)) {
      try {
        const holdings = await fetchBlackRockHoldingSymbols(universe, Math.max(input.ttlMs, 6 * 60 * 60_000));
        cached = cached || holdings.cached;
        const holdingSymbols = new Set(holdings.symbols.map(normalizeMarketDataSymbol));
        quotes.push(...input.allQuotes.filter((quote) => holdingSymbols.has(quote.symbol)));
        sources.push(holdings.provider);
      } catch (error) {
        warnings.push(error instanceof Error ? `${config.label} holdings failed: ${error.message}` : `${config.label} holdings failed.`);
      }
    }
  }

  return { quotes: uniqueQuotes(quotes), warnings, sources, cached };
}

function uniqueQuotes(quotes: MarketQuote[]): MarketQuote[] {
  return Array.from(new Map(quotes.map((quote) => [quote.symbol, quote])).values());
}

function nasdaqScreenerUrl(exchange?: NasdaqExchange): string {
  if (!exchange) return NASDAQ_SCREENER_URL;
  const url = new URL(NASDAQ_SCREENER_URL);
  url.searchParams.set("exchange", exchange);
  return url.toString();
}

function normalizeMarketDataSymbol(value: string): string {
  return normalizeSymbol(value).replace(/\//g, "-");
}

async function fetchQuoteOnlyMarketQuotes(symbols: string[], positions: EquityPosition[]): Promise<{ quotes: MarketQuote[]; warnings: string[] }> {
  const quotes: MarketQuote[] = [];
  const unresolved: string[] = [];
  const requested = Array.from(new Set(symbols.map(normalizeSymbol).filter(Boolean)));
  const results = await Promise.all(requested.map(async (symbol) => [symbol, await fetchYahooFinanceQuote(symbol)] as const));
  for (const [symbol, quote] of results) {
    if (quote) quotes.push(toQuoteOnlyMarketQuote(symbol, quote, positions));
    else unresolved.push(symbol);
  }
  const warnings = unresolved.length > 0
    ? [`No market data returned for custom symbol${unresolved.length === 1 ? "" : "s"}: ${unresolved.join(", ")}. Check the ticker or try again if the market data provider is temporarily unavailable.`]
    : [];
  return { quotes, warnings };
}

function toQuoteOnlyMarketQuote(symbol: string, quote: YahooFinanceQuote, positions: EquityPosition[]): MarketQuote {
  const prevClose = quote.prevClose > 0 ? quote.prevClose : quote.price;
  const netChange = quote.price - prevClose;
  const intradayChangePct = prevClose > 0 ? Math.round((netChange / prevClose) * 10_000) / 100 : 0;
  const position = positions.find((p) => normalizeSymbol(p.symbol) === symbol);
  return {
    symbol,
    price: quote.price,
    bid: quote.bid,
    ask: quote.ask,
    volume: quote.volume > 0 ? quote.volume : 0,
    intradayChangePct,
    netChange: Math.round(netChange * 100) / 100,
    sector: position?.sector,
    industry: position?.industry,
    positionMarketValue: position?.marketValue ?? 0,
    score: 0,
    provider: "yahoo-finance",
    asOf: new Date().toISOString(),
    sources: {
      price: "yahoo-finance",
      bid: "yahoo-finance",
      ask: "yahoo-finance",
      volume: "yahoo-finance",
      intradayChangePct: "yahoo-finance",
      asOf: "yahoo-finance"
    }
  };
}

// Merge a provider enrichment record onto a screener quote (first-non-undefined wins,
// enrichment overriding the screener). Exported + exhaustive on purpose: every enriched
// field on SymbolEnrichment must be folded here or it silently never reaches the quote —
// the dashboard, scoring, and the agent prompt all read these off MarketQuote. This is the
// "merge in market.ts" half of the cross-file enrichment trap documented in CLAUDE.md.
export function applyEnrichment(quote: MarketQuote, extra: SymbolEnrichment): MarketQuote {
  return {
    ...quote,
    price: extra.price && extra.price > 0 ? extra.price : quote.price,
    bid: extra.bid && extra.bid > 0 ? extra.bid : quote.bid,
    ask: extra.ask && extra.ask > 0 ? extra.ask : quote.ask,
    intradayChangePct: typeof extra.intradayChangePct === "number" ? extra.intradayChangePct : quote.intradayChangePct,
    vwap: extra.vwap && extra.vwap > 0 ? extra.vwap : quote.vwap,
    asOf: extra.asOf ?? quote.asOf,
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
    targetMean: extra.targetMean ?? quote.targetMean,
    targetHigh: extra.targetHigh ?? quote.targetHigh,
    targetLow: extra.targetLow ?? quote.targetLow,
    targetMedian: extra.targetMedian ?? quote.targetMedian,
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
    positioning: safeWeight(weights.positioning),
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
    positioning: sanitized.positioning / total,
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

/**
 * Intraday momentum: map intradayChangePct onto [0,100] using tanh over a ±20% range
 * instead of the prior saturating linear ±5% window. The old formula
 * `((pct + 5) / 10) * 100` capped at 100 for anything ≥ +5%, making a +6% gap-up
 * and a +25% short-squeeze indistinguishable. tanh(x/10) (where x is the pct value)
 * stays sensitive well past ±10%: +5%→73, +10%→88, +20%→97 — preserving meaningful
 * differentiation across the full realistic intraday range.
 */
function intradayMomentum(pct: number): number {
  // tanh maps ℝ → (-1, 1); shift+scale to [0, 100].
  return (Math.tanh(pct / 10) + 1) * 50;
}

function momentumScore(quote: MarketQuote): number {
  const intraday = intradayMomentum(quote.intradayChangePct);

  // Blend in the 52-week price position when available: near the high reflects
  // sustained strength/breakout; near the low reflects weakness (or mean-reversion).
  // DE-COLLINEARIZATION: when technicalScore IS present, it already encodes the
  // RSI/MACD/SMA-stack signals that are themselves functions of "price near its highs"
  // — the same information expressed by the 52-week position. Keeping the 52w weight
  // at 0.4 in that case would triple-count trend (intraday + 52w + technical). Instead
  // we reduce it to 0.15 when technicalScore is available, preserving a small
  // breakout/breakdown signal while removing the bulk of the redundancy.
  const pos = pricePosition52w(quote);
  const hasTech = typeof quote.technicalScore === "number";
  const w52 = hasTech ? 0.15 : 0.4;
  const base = typeof pos === "number"
    ? intraday * (1 - w52) + pos * w52
    : intraday;

  // Blend in the bar-based technical read when present (RSI/MACD/MA crossovers from a
  // real price-history series — the one momentum input the snapshot screener lacks).
  // Reduced from 0.5 to 0.4 (technical is informative but already subsumes much of the
  // 52-week-position signal above; keeping it at 0.5 was an implicit double-weight on
  // trend relative to the fresh intraday signal).
  if (hasTech) {
    return clamp(base * 0.6 + quote.technicalScore! * 0.4);
  }
  return clamp(base);
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

/**
 * Smart-money positioning sub-score (50 = neutral when no signal). Lifts names with
 * net congressional buying / insider open-market buying / squeeze-level short interest,
 * and dings net selling — so the scraped signals influence the deterministic ranking,
 * not just the LLM prompt. Populated from the web-source overlay (see scanMarket), so
 * the score is recomputed AFTER the overlay there.
 */
function positioningScore(quote: MarketQuote): number {
  let base = 50;
  if (typeof quote.senateTrades === "number" && quote.senateTrades !== 0) {
    // Net distinct congressional buy members minus sell members.
    base += quote.senateTrades > 0
      ? Math.min(18, 8 + (quote.senateTrades - 1) * 5)
      : -Math.min(18, 8 + (-quote.senateTrades - 1) * 5);
  }
  if (typeof quote.insiderSentiment === "number") {
    // 0–100 open-market Form 4 buy share (50 = balanced).
    if (quote.insiderSentiment >= 70) base += 12;
    else if (quote.insiderSentiment >= 60) base += 6;
    else if (quote.insiderSentiment <= 30) base -= 12;
    else if (quote.insiderSentiment <= 40) base -= 6;
  }
  if (typeof quote.shortPercentOfFloat === "number" && quote.shortPercentOfFloat >= 20) {
    base += 5; // squeeze potential (two-sided, so a small contribution only)
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
        targetMean: quote.targetMean,
        targetHigh: quote.targetHigh,
        targetLow: quote.targetLow,
        targetMedian: quote.targetMedian,
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
