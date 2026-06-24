// Market enrichment: fundamentals (P/E) + analyst-consensus sentiment layered on top of
// the NASDAQ screener scan.
//
// Provider cascade (first non-null value wins per field):
//   1. Finnhub           — news sentiment, analyst recs, profile, basic financials (FINNHUB_API_KEY)
//   2. FMP stable API    — P/E (ratios-ttm), analyst grades-consensus             (FMP_API_KEY)
//   3. Yahoo Finance     — sector, industry, P/E, EPS, div yield, analyst rating  (no key needed)
//
// Each keyed provider is only instantiated when its env key is set. Yahoo Finance is always
// the final real tier — no API key required, uses session crumb auth.

import { normalizeSymbol } from "./money";
import { resolveAlpacaMarketData, resolveApiKeyWithSource, hasDataPoolConsent, type ApiKeySource } from "./db";
import { getStreamedHeadlines } from "./streams/news-store";

// ── Enrichment cache scoping (mirrors src/lib/history.ts) ─────────────────────
// Data fetched with a user's own stored key is scoped to that user (private) or
// shared into the reciprocal data pool (pool) when they consent.  Data from an
// operator/env key or a free source is globally shared (shared), preserving the
// original behaviour and benefiting all users without consent implications.

type CacheScope = "shared" | "private" | "pool";

function cacheScopeForKeySource(source: ApiKeySource, userId: string | undefined): CacheScope {
  if (source !== "user") return "shared";
  if (shareUserKeyedEnrichment()) return "shared";
  if (hasDataPoolConsent(userId ?? "local")) return "pool";
  return "private";
}

function shareUserKeyedEnrichment(): boolean {
  const value = (process.env.MARKET_DATA_SHARE_USER_KEYED_HISTORY ?? "off").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function enrichmentCacheKey(prefix: string, symbol: string, scope: CacheScope, userId: string | undefined): string {
  if (scope === "private") return `user:${userId ?? "local"}:${prefix}:${symbol}`;
  if (scope === "pool") return `pool:${prefix}:${symbol}`;
  return `${prefix}:${symbol}`;
}

/** Read a cached enrichment entry respecting private → pool (if consented) → shared order. */
function readEnrichmentCache(
  prefix: string,
  symbol: string,
  userId: string | undefined,
  consented: boolean,
  now: number
): { expiresAt: number; data: SymbolEnrichment } | undefined {
  const privateHit = cache.get(enrichmentCacheKey(prefix, symbol, "private", userId));
  if (privateHit && privateHit.expiresAt > now) return privateHit;
  if (consented) {
    const poolHit = cache.get(enrichmentCacheKey(prefix, symbol, "pool", userId));
    if (poolHit && poolHit.expiresAt > now) return poolHit;
  }
  const sharedHit = cache.get(enrichmentCacheKey(prefix, symbol, "shared", userId));
  if (sharedHit && sharedHit.expiresAt > now) return sharedHit;
  return undefined;
}

/** Write a cached enrichment entry under the correct scope key. */
function writeEnrichmentCache(
  prefix: string,
  symbol: string,
  scope: CacheScope,
  userId: string | undefined,
  data: SymbolEnrichment,
  expiresAt: number
): void {
  cache.set(enrichmentCacheKey(prefix, symbol, scope, userId), { expiresAt, data });
}

// Per-source analyst breakdown so the Rating column can blend across providers and
// the tooltip can show each provider's individual read.
export interface AnalystRatingDetail {
  score: number;   // 0–100 (Strong Buy = 100 … Strong Sell = 0)
  label: string;   // Strong Buy / Buy / Hold / Sell / Strong Sell
  counts?: { strongBuy: number; buy: number; hold: number; sell: number; strongSell: number };
  mean?: number;   // analyst mean (1–5) when the source reports one instead of counts
}

export interface SymbolEnrichment {
  price?: number;
  bid?: number;
  ask?: number;
  intradayChangePct?: number;
  vwap?: number;        // session volume-weighted average price (Alpaca dailyBar.vw)
  asOf?: string;
  sentiment?: number;    // 0–100 news tone (50 = neutral). News-derived only.
  peRatio?: number;
  headlines?: string[];
  analystRating?: string;  // blended consensus label
  analystScore?: number;   // blended 0–100 analyst score
  sector?: string;
  industry?: string;
  volume?: number;
  dividendYield?: number; // annual dividend yield %
  eps?: number;           // earnings per share (TTM)
  companyName?: string;
  pbRatio?: number;
  shortPercentOfFloat?: number;
  beta?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  insiderSentiment?: number;
  fcfYield?: number;
  debtToEquity?: number;
  epsGrowth?: number;
  senateTrades?: number;
  // Which provider supplied each scalar field (filled by the cascade).
  sources?: Partial<Record<EnrichmentSourcedField, string>>;
  // Each provider's own analyst read, keyed by provider name (for the Rating tooltip).
  analystBySource?: Record<string, AnalystRatingDetail>;
}

export type EnrichmentSourcedField =
  | "price"
  | "bid"
  | "ask"
  | "intradayChangePct"
  | "vwap"
  | "asOf"
  | "sentiment"
  | "peRatio"
  | "analystRating"
  | "sector"
  | "industry"
  | "volume"
  | "dividendYield"
  | "eps"
  | "companyName"
  | "pbRatio"
  | "shortPercentOfFloat"
  | "beta"
  | "fiftyTwoWeekHigh"
  | "fiftyTwoWeekLow"
  | "insiderSentiment"
  | "fcfYield"
  | "debtToEquity"
  | "epsGrowth"
  | "senateTrades";

export interface MarketEnrichmentProvider {
  name: string;
  configured: boolean;
  enrich(symbols: string[]): Promise<Record<string, SymbolEnrichment>>;
}

// ── Analyst scoring helpers ───────────────────────────────────────────────────
// Map ratings onto a 0–100 scale so multiple sources can be averaged.

export function labelFromAnalystScore(score: number): string {
  if (score >= 85) return "Strong Buy";
  if (score >= 65) return "Buy";
  if (score >= 45) return "Hold";
  if (score >= 25) return "Sell";
  return "Strong Sell";
}

export function analystScoreFromCounts(c: {
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
}): number | undefined {
  const total = c.strongBuy + c.buy + c.hold + c.sell + c.strongSell;
  if (total <= 0) return undefined;
  return (c.strongBuy * 100 + c.buy * 75 + c.hold * 50 + c.sell * 25 + c.strongSell * 0) / total;
}

// Analyst mean: 1 = Strong Buy … 5 = Strong Sell.
export function analystScoreFromMean(mean: number): number {
  return Math.max(0, Math.min(100, ((5 - mean) / 4) * 100));
}

const DEFAULT_TTL_MS = 6 * 60 * 60_000; // fundamentals move slowly; cache 6h
// Cover the default scan candidate set so every row the dashboard displays is
// enriched — otherwise symbols that climb in rank after enrichment would render
// blank. The 6h cache means only the first run is heavy.
const DEFAULT_MAX_SYMBOLS = 30;
const MAX_SYMBOLS_CAP = 50;
const CONCURRENCY = 5;
const cache = new Map<string, { expiresAt: number; data: SymbolEnrichment }>();

// Well-known ticker mock data — real-ish values updated periodically.
const MOCK_METRICS: Record<string, Omit<SymbolEnrichment, "volume"> & Required<Pick<SymbolEnrichment, "sector" | "industry" | "peRatio" | "analystRating" | "sentiment" | "dividendYield" | "eps" | "headlines">>> = {
  AAPL: { sector: "Technology", industry: "Consumer Electronics", peRatio: 31.4, analystRating: "Buy", sentiment: 72, dividendYield: 0.44, eps: 6.97, headlines: ["Apple reaches new record high on AI optimism.", "Analysts praise Apple's new consumer AI integrations."] },
  MSFT: { sector: "Technology", industry: "Software—Infrastructure", peRatio: 35.8, analystRating: "Strong Buy", sentiment: 78, dividendYield: 0.71, eps: 12.41, headlines: ["Microsoft expanding Azure cloud capabilities globally.", "Microsoft beats earnings expectations as cloud services surge."] },
  VOO:  { sector: "ETF", industry: "Index Fund", peRatio: 25.2, analystRating: "Buy", sentiment: 60, dividendYield: 1.25, eps: 0, headlines: ["S&P 500 index fund VOO tracking towards new highs.", "Diversified index investing remains popular."] },
  NVDA: { sector: "Technology", industry: "Semiconductors", peRatio: 65.2, analystRating: "Strong Buy", sentiment: 85, dividendYield: 0.02, eps: 2.94, headlines: ["NVIDIA stock surges as AI chip demand reaches unprecedented levels.", "NVIDIA announces next-generation chip architecture."] },
  AMZN: { sector: "Consumer Cyclical", industry: "Internet Retail", peRatio: 40.5, analystRating: "Buy", sentiment: 68, dividendYield: 0, eps: 5.29, headlines: ["Amazon expands fulfillment centers to speed up delivery.", "AWS earnings exceed analyst estimates on cloud growth."] },
  TSLA: { sector: "Consumer Cyclical", industry: "Auto Manufacturers", peRatio: 55.4, analystRating: "Hold", sentiment: 48, dividendYield: 0, eps: 2.18, headlines: ["Tesla deliveries fluctuate amid high global competition.", "Tesla showcases advances in self-driving software."] },
  JPM:  { sector: "Financial Services", industry: "Banks—Diversified", peRatio: 12.1, analystRating: "Buy", sentiment: 58, dividendYield: 2.05, eps: 19.75, headlines: ["JPMorgan Chase reports strong investment banking income.", "JPMorgan expanding physical branch network in key states."] },
  GOOG: { sector: "Technology", industry: "Internet Content & Information", peRatio: 24.5, analystRating: "Buy", sentiment: 70, dividendYield: 0.45, eps: 7.54, headlines: ["Google enhances Search with new AI-powered summaries.", "Alphabet reports steady ad revenue growth."] },
  GOOGL:{ sector: "Technology", industry: "Internet Content & Information", peRatio: 24.5, analystRating: "Buy", sentiment: 70, dividendYield: 0.45, eps: 7.54, headlines: ["Alphabet reports steady ad revenue growth.", "Google AI tools expand across consumer products."] },
  META: { sector: "Technology", industry: "Internet Content & Information", peRatio: 28.2, analystRating: "Buy", sentiment: 74, dividendYield: 0.32, eps: 22.10, headlines: ["Meta platform active user counts continue to climb.", "Meta showcases open-source AI models for developers."] },
  AMD:  { sector: "Technology", industry: "Semiconductors", peRatio: 42.1, analystRating: "Buy", sentiment: 65, dividendYield: 0, eps: 3.31, headlines: ["AMD launches new processors for AI laptops.", "AMD gains server market share against key competitors."] },
  NFLX: { sector: "Communication Services", industry: "Entertainment", peRatio: 36.4, analystRating: "Buy", sentiment: 62, dividendYield: 0, eps: 22.79, headlines: ["Netflix subscriber growth accelerates on new original content.", "Netflix testing ads-supported subscription tier in new markets."] },
  INTC: { sector: "Technology", industry: "Semiconductors", peRatio: 18.2, analystRating: "Hold", sentiment: 44, dividendYield: 1.02, eps: 1.43, headlines: ["Intel reports steady progress on next-gen fabrication nodes.", "Intel cost-cutting measures improve near-term margins."] },
  DIS:  { sector: "Communication Services", industry: "Entertainment", peRatio: 21.5, analystRating: "Buy", sentiment: 56, dividendYield: 0.85, eps: 4.24, headlines: ["Disney streaming subscribers grow amid content slate expansion.", "Disney parks revenue rises on tourism demand."] },
  BA:   { sector: "Industrials", industry: "Aerospace & Defense", peRatio: 28.0, analystRating: "Hold", sentiment: 50, dividendYield: 0, eps: 3.20, headlines: ["Boeing stabilizing production after quality review.", "Boeing secures new international commercial jet orders."] },
  PFE:  { sector: "Healthcare", industry: "Drug Manufacturers", peRatio: 14.2, analystRating: "Hold", sentiment: 45, dividendYield: 6.10, eps: 2.58, headlines: ["Pfizer pipeline shows promise in oncology pipeline.", "Pfizer dividend remains sustainable amid cost restructuring."] },
  JNJ:  { sector: "Healthcare", industry: "Drug Manufacturers", peRatio: 16.4, analystRating: "Buy", sentiment: 58, dividendYield: 3.10, eps: 8.77, headlines: ["J&J pharmaceutical revenue grows on new drug approvals.", "Johnson & Johnson raises full-year revenue guidance."] },
  WMT:  { sector: "Consumer Defensive", industry: "Discount Stores", peRatio: 30.2, analystRating: "Buy", sentiment: 65, dividendYield: 1.12, eps: 2.23, headlines: ["Walmart grocery share gains continue amid consumer value focus.", "Walmart e-commerce growth accelerates internationally."] },
  BRK:  { sector: "Financial Services", industry: "Insurance", peRatio: 22.0, analystRating: "Buy", sentiment: 62, dividendYield: 0, eps: 16.40, headlines: ["Berkshire Hathaway reports strong investment portfolio returns.", "Warren Buffett continues disciplined capital allocation strategy."] },
  V:    { sector: "Financial Services", industry: "Credit Services", peRatio: 31.8, analystRating: "Strong Buy", sentiment: 71, dividendYield: 0.76, eps: 9.88, headlines: ["Visa payment volumes rise on global travel and commerce.", "Visa expanding digital payments in emerging markets."] },
  MA:   { sector: "Financial Services", industry: "Credit Services", peRatio: 35.5, analystRating: "Strong Buy", sentiment: 72, dividendYield: 0.55, eps: 13.58, headlines: ["Mastercard cross-border volumes rise on travel recovery.", "Mastercard services revenue grows ahead of expectations."] },
  UNH:  { sector: "Healthcare", industry: "Healthcare Plans", peRatio: 22.1, analystRating: "Buy", sentiment: 60, dividendYield: 1.65, eps: 26.13, headlines: ["UnitedHealth Group raises annual EPS guidance.", "UNH Optum segment delivers strong growth in care services."] },
};

function getFallbackMetrics(symbol: string): SymbolEnrichment {
  // Deterministic hash-based pseudo-data for unknown symbols.
  const hash = symbol.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const sectors = ["Technology", "Financial Services", "Consumer Cyclical", "Healthcare", "Industrials", "Consumer Defensive", "Communication Services"];
  const industries = ["Software", "Banks", "Retail", "Biotechnology", "Manufacturing", "Semiconductors", "Internet Services"];
  const ratings = ["Buy", "Hold", "Strong Buy", "Buy", "Hold"]; // weight towards Buy/Hold
  return {
    sector: sectors[hash % sectors.length],
    industry: industries[hash % industries.length],
    peRatio: 10 + (hash % 40) + 0.5,
    analystRating: ratings[hash % ratings.length],
    sentiment: 40 + (hash % 30),
    dividendYield: (hash % 300) / 100,
    eps: (hash % 2000) / 100,
    headlines: [
      `${symbol} reports quarterly results inline with guidance.`,
      `Analysts maintain stable outlook on ${symbol}.`
    ]
  };
}

function ttlMs(): number {
  const value = Number(process.env.NEWS_CACHE_TTL_MS ?? DEFAULT_TTL_MS);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_TTL_MS;
}

function maxSymbols(): number {
  const value = Number(process.env.FMP_MAX_SYMBOLS ?? process.env.MARKET_SCAN_LIMIT ?? DEFAULT_MAX_SYMBOLS);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX_SYMBOLS;
  return Math.min(value, MAX_SYMBOLS_CAP);
}

// One retry on HTTP 429 (rate limit) with a short backoff before giving up.
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: { retries?: number; backoffMs?: number } = {}
): Promise<Response> {
  const retries = options.retries ?? 1;
  const backoffMs = options.backoffMs ?? 600;
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, init);
    if (response.status === 429 && attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, backoffMs * (attempt + 1)));
      continue;
    }
    return response;
  }
}

// ── Provider factory ────────────────────────────────────────────────────────
// Builds a cascade: [Finnhub?, FMP?] → Yahoo Finance.
// Yahoo Finance requires no API key and is always the final real tier.

export function getEnrichmentProvider(userId?: string): MarketEnrichmentProvider {
  const providers: MarketEnrichmentProvider[] = [];
  const finnhub = resolveApiKeyWithSource("finnhub", userId);
  const alphaVantage = resolveApiKeyWithSource("alphavantage", userId);
  const fmp = resolveApiKeyWithSource("fmp", userId);
  const fintech = resolveApiKeyWithSource("fintechstudios", userId);
  // Alpaca MARKET DATA: own key (individual) → operator's paper key (shared) for background/tenants.
  // Trading is unaffected (alpaca.ts resolves Alpaca strictly per-user).
  const alpacaData = resolveAlpacaMarketData(userId);
  // ── Freshness-tier ordering (first-wins cascade) ──────────────────────────
  // The cascade below is first-wins per field (takeScalar keeps the first non-undefined
  // value). So provider ORDER decides which source wins the price-family fields
  // (price / bid / ask / volume / vwap / intradayChangePct). To make the MOST CURRENT
  // source win those fields, the real-time market-data provider must resolve FIRST —
  // ahead of delayed sources (webull/robinhood/finnhub/etc.).
  //
  // Tier 1 — REAL-TIME market data: Alpaca's IEX snapshot. It supplies ONLY the
  // price-family fields (price/bid/ask/volume/vwap/intradayChangePct) and no
  // fundamentals/analyst/sentiment, so seating it first wins real-time quotes
  // WITHOUT disturbing fundamentals sourcing (still finnhub/fmp/yahoo below). It
  // self-skips when either Alpaca key is absent — then the delayed sources fill these
  // fields in exactly the same order they would today.
  if (alpacaData.apiKey && alpacaData.secretKey) providers.push(new AlpacaSnapshotEnrichmentProvider(alpacaData.apiKey, alpacaData.secretKey, alpacaData.source, userId));
  // Tier 2 — DELAYED quotes + fundamentals, in availability order (unchanged relative ordering).
  if (webullUnofficialEnabled()) providers.push(new WebullUnofficialEnrichmentProvider());
  // First-party Robinhood fundamentals — opt-in: requires ROBINHOOD_ADAPTER=mcp (connected)
  // AND ROBINHOOD_ENRICHMENT_ENABLED, because the broker field set/units should be verified
  // against /api/admin/robinhood-probe before trusting them next to other real numbers.
  // (This is delayed/averaged fundamentals — e.g. average_volume — not a real-time quote,
  // so it stays in the delayed tier rather than next to the Alpaca snapshot.)
  if (robinhoodEnrichmentEnabled()) providers.push(new RobinhoodEnrichmentProvider(userId));
  if (fintech.key) providers.push(new FintechStudiosEnrichmentProvider(fintech.key, fintech.source, userId));
  if (finnhub.key) providers.push(new FinnhubEnrichmentProvider(finnhub.key, finnhub.source, userId));
  // Alpaca's free Benzinga news (one batched call covers all scan symbols) — placed ahead of
  // Alpha Vantage so it supplies headlines/sentiment, demoting AV's redundant NEWS_SENTIMENT.
  if (alpacaData.apiKey) providers.push(new AlpacaNewsEnrichmentProvider(alpacaData.apiKey, alpacaData.secretKey || undefined, alpacaData.source, userId));
  if (alphaVantage.key) providers.push(new AlphaVantageEnrichmentProvider(alphaVantage.key, alphaVantage.source, userId));
  if (fmp.key) providers.push(new FmpEnrichmentProvider(fmp.key, fmp.source, userId));
  providers.push(new YahooFinanceEnrichmentProvider());
  // Always wrap in the cascade — even for a single provider — so per-field source
  // stamping and analyst blending happen uniformly.
  return new CascadingEnrichmentProvider(providers);
}

// ── Mock / fallback provider (always configured) ────────────────────────────

export const mockEnrichmentProvider: MarketEnrichmentProvider = {
  name: "mock-enrichment",
  configured: true,
  async enrich(symbols: string[]): Promise<Record<string, SymbolEnrichment>> {
    const result: Record<string, SymbolEnrichment> = {};
    for (const raw of symbols) {
      const symbol = normalizeSymbol(raw);
      if (!symbol) continue;
      result[symbol] = MOCK_METRICS[symbol] ?? getFallbackMetrics(symbol);
    }
    return result;
  }
};

// Keep the old export name for any code that references it.
export const noopProvider = mockEnrichmentProvider;

// ── Cascading provider ──────────────────────────────────────────────────────
// Runs all child providers in parallel. For each scalar field it takes the first
// non-undefined value (Finnhub fills what it can, FMP fills gaps, Yahoo fills the
// rest) and records which provider supplied it. Analyst ratings are NOT first-wins:
// every provider's read is collected and blended into one 0–100 score + label.

class CascadingEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name: string;
  readonly configured = true;

  constructor(private readonly providers: MarketEnrichmentProvider[]) {
    this.name = providers.map((p) => p.name).join("+");
  }

  async enrich(symbols: string[]): Promise<Record<string, SymbolEnrichment>> {
    // Run all providers in parallel; pair each result set with its provider name.
    const results = await Promise.all(
      this.providers.map((p) =>
        p
          .enrich(symbols)
          .then((data) => ({ name: p.name, data }))
          .catch(() => ({ name: p.name, data: {} as Record<string, SymbolEnrichment> }))
      )
    );
    const merged: Record<string, SymbolEnrichment> = {};
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean);

    for (const symbol of normalized) {
      const base: SymbolEnrichment = {};
      const sources: Partial<Record<EnrichmentSourcedField, string>> = {};
      const analystBySource: Record<string, AnalystRatingDetail> = {};

      const takeScalar = <K extends keyof SymbolEnrichment>(
        field: K,
        sourceName: string,
        value: SymbolEnrichment[K] | undefined
      ) => {
        if (base[field] === undefined && value !== undefined) {
          base[field] = value;
          if (field in EMPTY_SOURCED) sources[field as EnrichmentSourcedField] = sourceName;
        }
      };

      for (const { name, data } of results) {
        const r = data[symbol];
        if (!r) continue;
        takeScalar("price", name, r.price);
        takeScalar("bid", name, r.bid);
        takeScalar("ask", name, r.ask);
        takeScalar("intradayChangePct", name, r.intradayChangePct);
        takeScalar("vwap", name, r.vwap);
        takeScalar("asOf", name, r.asOf);
        takeScalar("sentiment", name, r.sentiment);
        takeScalar("peRatio", name, r.peRatio);
        takeScalar("sector", name, r.sector);
        takeScalar("industry", name, r.industry);
        takeScalar("volume", name, r.volume);
        takeScalar("dividendYield", name, r.dividendYield);
        takeScalar("eps", name, r.eps);
        takeScalar("companyName", name, r.companyName);
        takeScalar("pbRatio", name, r.pbRatio);
        takeScalar("shortPercentOfFloat", name, r.shortPercentOfFloat);
        takeScalar("beta", name, r.beta);
        takeScalar("fiftyTwoWeekHigh", name, r.fiftyTwoWeekHigh);
        takeScalar("fiftyTwoWeekLow", name, r.fiftyTwoWeekLow);
        takeScalar("insiderSentiment", name, r.insiderSentiment);
        takeScalar("fcfYield", name, r.fcfYield);
        takeScalar("debtToEquity", name, r.debtToEquity);
        takeScalar("epsGrowth", name, r.epsGrowth);
        takeScalar("senateTrades", name, r.senateTrades);
        if (!base.headlines?.length && r.headlines?.length) base.headlines = r.headlines;
        // Collect every provider's analyst read.
        if (r.analystBySource) Object.assign(analystBySource, r.analystBySource);
      }

      // Blend analyst scores across all sources that reported one.
      const detail = Object.values(analystBySource);
      if (detail.length > 0) {
        const blended = detail.reduce((sum, d) => sum + d.score, 0) / detail.length;
        base.analystScore = Math.round(blended);
        base.analystRating = labelFromAnalystScore(blended);
        base.analystBySource = analystBySource;
        sources.analystRating = Object.keys(analystBySource).length > 1 ? "blended" : Object.keys(analystBySource)[0];
      }

      // Prefer a REAL model sentiment (Alpha Vantage NEWS_SENTIMENT) over the keyword-proxy
      // sentiment that Finnhub/Alpaca synthesize via scoreHeadlines. The first-wins takeScalar
      // above lets the proxy win because Finnhub runs earlier; override here when AV returned a
      // numeric model score for this symbol (falls back to the proxy when AV has none).
      const avSentiment = results.find((res) => res.name === "alpha-vantage")?.data[symbol]?.sentiment;
      if (typeof avSentiment === "number") {
        base.sentiment = avSentiment;
        sources.sentiment = "alpha-vantage";
      }

      base.sources = sources;
      merged[symbol] = base;
    }
    return merged;
  }
}

// Marker set so takeScalar only stamps fields that are actually sourced (not headlines/analyst).
const EMPTY_SOURCED: Record<EnrichmentSourcedField, true> = {
  price: true,
  bid: true,
  ask: true,
  intradayChangePct: true,
  vwap: true,
  asOf: true,
  sentiment: true,
  peRatio: true,
  analystRating: true,
  sector: true,
  industry: true,
  volume: true,
  dividendYield: true,
  eps: true,
  companyName: true,
  pbRatio: true,
  shortPercentOfFloat: true,
  beta: true,
  fiftyTwoWeekHigh: true,
  fiftyTwoWeekLow: true,
  insiderSentiment: true,
  fcfYield: true,
  debtToEquity: true,
  epsGrowth: true,
  senateTrades: true
};

// ── Webull unofficial quote bridge (opt-in, market-data only) ────────────────
// This shells out to scripts/webull_unofficial_quote.py, which uses the community
// tedchou12/webull package without logging in. It is disabled by default and never
// implements broker orders or learning fills.

const WEBULL_UNOFFICIAL_SOURCE = "webull-unofficial";
const DEFAULT_WEBULL_UNOFFICIAL_MAX = 20;

export function webullUnofficialEnabled(): boolean {
  return ["1", "true", "on", "yes"].includes(String(process.env.WEBULL_UNOFFICIAL_ENABLED ?? "").trim().toLowerCase());
}

function webullUnofficialMaxSymbols(): number {
  const value = Number(process.env.WEBULL_UNOFFICIAL_MAX_SYMBOLS ?? DEFAULT_WEBULL_UNOFFICIAL_MAX);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_WEBULL_UNOFFICIAL_MAX;
  return Math.min(value, MAX_SYMBOLS_CAP);
}

function webullUnofficialTimeoutMs(): number {
  const value = Number(process.env.WEBULL_UNOFFICIAL_TIMEOUT_MS ?? 8000);
  return Number.isFinite(value) && value >= 1000 ? value : 8000;
}

export function parseWebullUnofficialQuote(payload: unknown): SymbolEnrichment {
  if (!payload || typeof payload !== "object" || "_error" in payload) return {};
  const row = payload as Record<string, unknown>;
  const price = firstNumber(row, ["pPrice", "close", "price", "lastPrice", "latestPrice", "last"]);
  const bid = firstNumber(row, ["bid", "bidPrice", "bid_price"]);
  const ask = firstNumber(row, ["ask", "askPrice", "ask_price"]);
  const prevClose = firstNumber(row, ["preClose", "prevClose", "previousClose", "priorClose"]);
  const rawChangePct = firstNumber(row, ["changeRatio", "changePercent", "pctChange", "changePct"]);
  const volume = firstNumber(row, ["volume", "vol", "tradeVolume"]);
  const peRatio = firstNumber(row, ["peTtm", "pe", "peRatio"]);
  const eps = firstNumber(row, ["epsTtm", "eps"]);
  const pbRatio = firstNumber(row, ["pb", "pbRatio", "priceToBook"]);
  const rawDividendYield = firstNumber(row, ["yield", "dividendYield"]);
  const fiftyTwoWeekHigh = firstNumber(row, ["fiftyTwoWkHigh", "high52w", "high52wk", "week52High", "fiftyTwoWeekHigh"]);
  const fiftyTwoWeekLow = firstNumber(row, ["fiftyTwoWkLow", "low52w", "low52wk", "week52Low", "fiftyTwoWeekLow"]);
  const companyName = firstString(row, ["name", "companyName", "disSymbolName"]);
  const asOf = firstString(row, ["timestamp", "tradeTime", "time", "updateTime"]);
  const dividendYield =
    rawDividendYield !== undefined && rawDividendYield >= 0
      ? Math.round((rawDividendYield <= 1 ? rawDividendYield * 100 : rawDividendYield) * 100) / 100
      : undefined;
  const intradayChangePct =
    rawChangePct !== undefined
      ? normalizePercent(rawChangePct)
      : price !== undefined && prevClose !== undefined && prevClose > 0
        ? Math.round(((price - prevClose) / prevClose) * 10000) / 100
        : undefined;

  return {
    ...(price !== undefined && { price }),
    ...(bid !== undefined && { bid }),
    ...(ask !== undefined && { ask }),
    ...(intradayChangePct !== undefined && { intradayChangePct }),
    ...(volume !== undefined && volume > 0 && { volume }),
    ...(peRatio !== undefined && peRatio > 0 && { peRatio }),
    ...(eps !== undefined && { eps }),
    ...(pbRatio !== undefined && pbRatio > 0 && { pbRatio }),
    ...(dividendYield !== undefined && { dividendYield }),
    ...(fiftyTwoWeekHigh !== undefined && fiftyTwoWeekHigh > 0 && { fiftyTwoWeekHigh }),
    ...(fiftyTwoWeekLow !== undefined && fiftyTwoWeekLow > 0 && { fiftyTwoWeekLow }),
    ...(companyName !== undefined && { companyName }),
    ...(asOf !== undefined && { asOf })
  };
}

export class WebullUnofficialEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = WEBULL_UNOFFICIAL_SOURCE;
  readonly configured = true;

  async enrich(symbols: string[]): Promise<Record<string, SymbolEnrichment>> {
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean).slice(0, webullUnofficialMaxSymbols());
    if (normalized.length === 0) return {};

    const now = Date.now();
    const result: Record<string, SymbolEnrichment> = {};
    const misses: string[] = [];
    for (const symbol of normalized) {
      // Webull unofficial uses no user-stored API key — always shared scope.
      const cached = cache.get(`${this.name}:${symbol}`);
      if (cached && cached.expiresAt > now) result[symbol] = cached.data;
      else misses.push(symbol);
    }
    if (misses.length === 0) return result;

    const python = process.env.WEBULL_UNOFFICIAL_PYTHON || "python3";
    const script = process.env.WEBULL_UNOFFICIAL_SCRIPT || `${process.cwd()}/scripts/webull_unofficial_quote.py`;
    try {
      const stdout = await runWebullUnofficialScript(python, script, misses, webullUnofficialTimeoutMs());
      const payload = JSON.parse(stdout || "{}") as Record<string, unknown>;
      for (const symbol of misses) {
        const data = parseWebullUnofficialQuote(payload[symbol]);
        cache.set(`${this.name}:${symbol}`, { expiresAt: now + ttlMs(), data });
        result[symbol] = data;
      }
    } catch {
      for (const symbol of misses) result[symbol] = {};
    }
    return result;
  }
}

function runWebullUnofficialScript(
  python: string,
  script: string,
  symbols: string[],
  timeout: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const requireFn = eval("require") as (id: string) => unknown;
    const childProcess = requireFn("child_process") as {
      execFile: (
        file: string,
        args: string[],
        options: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv },
        callback: (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void
      ) => void;
    };
    childProcess.execFile(
      python,
      [script, ...symbols],
      {
        timeout,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, PYTHONUNBUFFERED: "1" }
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(String(stdout ?? ""));
      }
    );
  });
}

// ── Robinhood first-party fundamentals (opt-in) ──────────────────────────────
// Sources fundamentals from the authenticated Robinhood MCP `get_equity_fundamentals`
// tool. Only high-confidence fields are mapped (P/E, sector/industry, 52-week range,
// average volume) to avoid unit-ambiguity surprises; verify the raw shape via
// /api/admin/robinhood-probe before relying on it. Inert unless explicitly enabled.

export function robinhoodEnrichmentEnabled(): boolean {
  if (process.env.ROBINHOOD_ADAPTER !== "mcp") return false;
  return ["1", "true", "on", "yes"].includes(String(process.env.ROBINHOOD_ENRICHMENT_ENABLED ?? "").trim().toLowerCase());
}

export function parseRobinhoodFundamentals(row: Record<string, unknown>): SymbolEnrichment {
  const peRatio = firstNumber(row, ["pe_ratio", "peRatio"]);
  const fiftyTwoWeekHigh = firstNumber(row, ["high_52_weeks", "fiftyTwoWeekHigh", "high52Weeks"]);
  const fiftyTwoWeekLow = firstNumber(row, ["low_52_weeks", "fiftyTwoWeekLow", "low52Weeks"]);
  const volume = firstNumber(row, ["average_volume", "average_volume_2_weeks", "volume"]);
  const sector = firstString(row, ["sector"]);
  const industry = firstString(row, ["industry"]);
  return {
    ...(peRatio !== undefined && peRatio > 0 && { peRatio }),
    ...(fiftyTwoWeekHigh !== undefined && fiftyTwoWeekHigh > 0 && { fiftyTwoWeekHigh }),
    ...(fiftyTwoWeekLow !== undefined && fiftyTwoWeekLow > 0 && { fiftyTwoWeekLow }),
    ...(volume !== undefined && volume > 0 && { volume }),
    ...(sector !== undefined && { sector }),
    ...(industry !== undefined && { industry })
  };
}

export class RobinhoodEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = "robinhood-fundamentals";
  readonly configured = true;
  private readonly scope: CacheScope;

  // SECURITY: the Robinhood OAuth token is per-user. This provider is constructed with the
  // request-scoped userId (see getEnrichmentProvider) and threads it into the fundamentals
  // fetch so user B never resolves user A's ('local') broker token. A pass with no user in
  // scope (undefined) fails closed — it returns empty enrichment rather than borrowing the
  // operator's token for a shared/background scan.
  //
  // The fundamentals themselves (pe_ratio, 52-wk hi/lo, avg volume, sector, industry) are PUBLIC
  // market data — not the user's private account. So, exactly like every other user-keyed source,
  // they are cached consent-pooled: pool tier when the user opted into the reciprocal data pool,
  // otherwise kept private to that user (a `user` keySource is never force-shared without consent).
  constructor(private readonly userId?: string) {
    this.scope = cacheScopeForKeySource("user", userId);
  }

  async enrich(symbols: string[]): Promise<Record<string, SymbolEnrichment>> {
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean).slice(0, maxSymbols());
    if (normalized.length === 0) return {};
    const result: Record<string, SymbolEnrichment> = {};
    // Fail closed when there is no user in scope: a private per-user broker credential must
    // never be sourced from the dev/operator 'local' identity for an anonymous enrichment pass.
    if (!this.userId) {
      for (const symbol of normalized) result[symbol] = {};
      return result;
    }

    const now = Date.now();
    const consented = hasDataPoolConsent(this.userId);
    const misses: string[] = [];
    // Serve from the consent-aware cache first (private → pool-if-consented → shared). A consenting
    // user reads bars/fundamentals another consenting user already fetched, without spending a call.
    for (const symbol of normalized) {
      const cached = readEnrichmentCache("robinhood-fundamentals", symbol, this.userId, consented, now);
      if (cached) result[symbol] = cached.data;
      else misses.push(symbol);
    }
    if (misses.length === 0) return result;

    try {
      const { fetchRobinhoodFundamentals } = await import("./robinhood");
      const raw = await fetchRobinhoodFundamentals(misses, this.userId);
      for (const symbol of misses) {
        const row = raw[symbol];
        const data = row ? parseRobinhoodFundamentals(row) : {};
        if (Object.keys(data).length > 0) {
          writeEnrichmentCache("robinhood-fundamentals", symbol, this.scope, this.userId, data, now + ttlMs());
        }
        result[symbol] = data;
      }
    } catch {
      for (const symbol of misses) result[symbol] = {};
    }
    return result;
  }
}

// ── Alpaca news provider (free Benzinga feed) ────────────────────────────────
// Keyed by Alpaca paper API key+secret (no IP-reputation issues, reliable from servers).
// One batched call returns recent articles tagged with their symbols; we group headlines
// per symbol and derive a sentiment proxy via scoreHeadlines. Supplies headlines + sentiment.

export class AlpacaNewsEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = "alpaca-news";
  readonly configured = true;
  private readonly base = "https://data.alpaca.markets/v1beta1/news";
  private readonly scope: CacheScope;

  constructor(
    private readonly apiKey: string,
    private readonly apiSecret?: string,
    keySource: ApiKeySource = "env",
    private readonly userId?: string
  ) {
    this.scope = cacheScopeForKeySource(keySource, userId);
  }

  async enrich(symbols: string[]): Promise<Record<string, SymbolEnrichment>> {
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean).slice(0, maxSymbols());
    if (normalized.length === 0) return {};

    const now = Date.now();
    const consented = hasDataPoolConsent(this.userId ?? "local");
    const result: Record<string, SymbolEnrichment> = {};
    const misses: string[] = [];
    for (const symbol of normalized) {
      const cached = readEnrichmentCache("alpaca-news", symbol, this.userId, consented, now);
      if (cached) {
        result[symbol] = cached.data;
        continue;
      }
      // Push-first: if the WebSocket worker has fresh streamed headlines for this symbol, use
      // them and skip the REST call. Falls back to REST when the stream is off/has nothing.
      const streamed = getStreamedHeadlines(symbol, ttlMs());
      if (streamed && streamed.length > 0) {
        const data: SymbolEnrichment = { headlines: streamed, sentiment: scoreHeadlines(streamed) };
        // Streamed headlines come from a shared websocket feed — always shared scope.
        writeEnrichmentCache("alpaca-news", symbol, "shared", this.userId, data, now + ttlMs());
        result[symbol] = data;
        continue;
      }
      misses.push(symbol);
    }
    if (misses.length === 0) return result;

    try {
      // Single batched request: Alpaca tags every article with the symbols it mentions.
      const url = `${this.base}?symbols=${encodeURIComponent(misses.join(","))}&limit=50&sort=desc`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      let articles: Array<{ headline?: string; symbols?: string[] }> = [];
      try {
        const headers: Record<string, string> = {
          accept: "application/json"
        };
        if (this.apiSecret) {
          headers["APCA-API-KEY-ID"] = this.apiKey;
          headers["APCA-API-SECRET-KEY"] = this.apiSecret;
        } else {
          headers["Authorization"] = `Bearer ${this.apiKey}`;
        }
        const response = await fetchWithRetry(url, {
          headers,
          cache: "no-store",
          signal: controller.signal
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const json = (await response.json()) as { news?: Array<{ headline?: string; symbols?: string[] }> };
        articles = Array.isArray(json.news) ? json.news : [];
      } finally {
        clearTimeout(timeout);
      }

      const headlinesBySymbol = new Map<string, string[]>();
      for (const article of articles) {
        const headline = typeof article.headline === "string" ? article.headline.trim() : "";
        if (!headline) continue;
        for (const raw of article.symbols ?? []) {
          const symbol = normalizeSymbol(raw);
          if (!symbol || !misses.includes(symbol)) continue;
          const list = headlinesBySymbol.get(symbol) ?? [];
          if (list.length < 5 && !list.includes(headline)) list.push(headline);
          headlinesBySymbol.set(symbol, list);
        }
      }

      for (const symbol of misses) {
        const headlines = headlinesBySymbol.get(symbol) ?? [];
        const data: SymbolEnrichment = headlines.length > 0 ? { headlines, sentiment: scoreHeadlines(headlines) } : {};
        if (headlines.length > 0) {
          writeEnrichmentCache("alpaca-news", symbol, this.scope, this.userId, data, now + ttlMs());
        }
        result[symbol] = data;
      }
    } catch {
      for (const symbol of misses) result[symbol] = {};
    }
    return result;
  }
}

// ── Alpaca snapshot provider (real bid/ask, price, volume, vwap, intraday change) ──
// Uses Alpaca's batch /v2/stocks/snapshots endpoint. The data feed defaults to
// IEX (free tier) and is configurable via ALPACA_DATA_FEED (iex|sip|otc).
// One request covers all scan symbols (chunked at 100 per call).
// Maps: price = latestTrade.p ?? dailyBar.c, bid = latestQuote.bp,
//       ask = latestQuote.ap, volume = dailyBar.v, vwap = dailyBar.vw,
//       intradayChangePct = (dailyBar.c − prevDailyBar.c) / prevDailyBar.c * 100.
// Only sets a field when the source value is present and > 0 — never fabricates.
// This is the fix for fabricated ±0.1% bid/ask spreads in the Market Scan panel.

const ALPACA_SNAPSHOT_CHUNK = 100; // Alpaca batch limit per request

// Data feed for the snapshot endpoint. The free plan only has IEX; SIP returns
// HTTP 403 ("subscription does not permit querying recent SIP data") unless the
// account has a paid SIP subscription. Configurable via ALPACA_DATA_FEED; any
// value outside the allowed set falls back to "iex".
const ALPACA_ALLOWED_FEEDS = ["iex", "sip", "otc"] as const;
export function alpacaDataFeed(): (typeof ALPACA_ALLOWED_FEEDS)[number] {
  const raw = String(process.env.ALPACA_DATA_FEED ?? "").trim().toLowerCase();
  return (ALPACA_ALLOWED_FEEDS as readonly string[]).includes(raw)
    ? (raw as (typeof ALPACA_ALLOWED_FEEDS)[number])
    : "iex";
}

export class AlpacaSnapshotEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = "alpaca-snapshot";
  readonly configured = true;
  private readonly base = "https://data.alpaca.markets/v2/stocks/snapshots";
  private readonly scope: CacheScope;

  constructor(
    private readonly apiKey: string,
    private readonly apiSecret: string,
    keySource: ApiKeySource = "env",
    private readonly userId?: string
  ) {
    this.scope = cacheScopeForKeySource(keySource, userId);
  }

  async enrich(symbols: string[]): Promise<Record<string, SymbolEnrichment>> {
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean).slice(0, maxSymbols());
    if (normalized.length === 0) return {};

    const now = Date.now();
    const consented = hasDataPoolConsent(this.userId ?? "local");
    const result: Record<string, SymbolEnrichment> = {};
    const misses: string[] = [];

    for (const symbol of normalized) {
      const cached = readEnrichmentCache("alpaca-snapshot", symbol, this.userId, consented, now);
      if (cached) result[symbol] = cached.data;
      else misses.push(symbol);
    }
    if (misses.length === 0) return result;

    // Chunk into batches of up to ALPACA_SNAPSHOT_CHUNK symbols.
    for (let i = 0; i < misses.length; i += ALPACA_SNAPSHOT_CHUNK) {
      const chunk = misses.slice(i, i + ALPACA_SNAPSHOT_CHUNK);
      try {
        const url = `${this.base}?symbols=${encodeURIComponent(chunk.join(","))}&feed=${alpacaDataFeed()}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        let snapshots: Record<string, AlpacaSnapshot>;
        try {
          const response = await fetchWithRetry(url, {
            headers: {
              "accept": "application/json",
              "APCA-API-KEY-ID": this.apiKey,
              "APCA-API-SECRET-KEY": this.apiSecret
            },
            cache: "no-store",
            signal: controller.signal
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          snapshots = (await response.json()) as Record<string, AlpacaSnapshot>;
        } finally {
          clearTimeout(timeout);
        }

        for (const symbol of chunk) {
          const snap = snapshots[symbol];
          const data = parseAlpacaSnapshot(snap);
          const hasData = Object.keys(data).length > 0;
          if (hasData) {
            writeEnrichmentCache("alpaca-snapshot", symbol, this.scope, this.userId, data, now + ttlMs());
          }
          result[symbol] = data;
        }
      } catch {
        for (const symbol of chunk) result[symbol] = {};
      }
    }
    return result;
  }
}

interface AlpacaSnapshot {
  latestTrade?: { p?: number };
  latestQuote?: { bp?: number; ap?: number };
  dailyBar?: { o?: number; h?: number; l?: number; c?: number; v?: number; vw?: number };
  prevDailyBar?: { c?: number };
}

export function parseAlpacaSnapshot(snap: AlpacaSnapshot | undefined | null): SymbolEnrichment {
  if (!snap) return {};

  const tradePrice = typeof snap.latestTrade?.p === "number" && snap.latestTrade.p > 0 ? snap.latestTrade.p : undefined;
  const barClose = typeof snap.dailyBar?.c === "number" && snap.dailyBar.c > 0 ? snap.dailyBar.c : undefined;
  const price = tradePrice ?? barClose;

  const bid = typeof snap.latestQuote?.bp === "number" && snap.latestQuote.bp > 0 ? snap.latestQuote.bp : undefined;
  const ask = typeof snap.latestQuote?.ap === "number" && snap.latestQuote.ap > 0 ? snap.latestQuote.ap : undefined;

  const volume = typeof snap.dailyBar?.v === "number" && snap.dailyBar.v > 0 ? snap.dailyBar.v : undefined;

  // Session VWAP comes free on every snapshot via dailyBar.vw. Only map it when
  // it is a real positive number — never fabricate.
  const vwap = typeof snap.dailyBar?.vw === "number" && snap.dailyBar.vw > 0 ? snap.dailyBar.vw : undefined;

  let intradayChangePct: number | undefined;
  const prevClose = typeof snap.prevDailyBar?.c === "number" && snap.prevDailyBar.c > 0 ? snap.prevDailyBar.c : undefined;
  if (barClose !== undefined && prevClose !== undefined && prevClose > 0) {
    intradayChangePct = Math.round(((barClose - prevClose) / prevClose) * 10000) / 100;
  }

  return {
    ...(price !== undefined && { price }),
    ...(bid !== undefined && { bid }),
    ...(ask !== undefined && { ask }),
    ...(volume !== undefined && { volume }),
    ...(vwap !== undefined && { vwap }),
    ...(intradayChangePct !== undefined && { intradayChangePct })
  };
}

// ── Yahoo Finance provider (no API key required) ─────────────────────────────
// Uses Yahoo Finance session-crumb auth to call v10/finance/quoteSummary.
// Provides: sector, industry, P/E, EPS, dividend yield, and analyst rating.

interface YfCreds { cookie: string; crumb: string; expiresAt: number; }
let yfCreds: YfCreds | null = null;
const YF_CRUMB_TTL_MS = 55 * 60_000; // 55 min (crumbs expire ~1 hr)
const YF_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

class YahooFinanceEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = "yahoo-finance";
  readonly configured = true;

  async enrich(symbols: string[]): Promise<Record<string, SymbolEnrichment>> {
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean).slice(0, maxSymbols());
    if (normalized.length === 0) return {};

    const now = Date.now();
    const result: Record<string, SymbolEnrichment> = {};
    const misses: string[] = [];
    for (const symbol of normalized) {
      // Yahoo Finance uses no user-stored API key — always shared scope.
      const cached = cache.get(`yf:${symbol}`);
      if (cached && cached.expiresAt > now) result[symbol] = cached.data;
      else misses.push(symbol);
    }
    if (misses.length === 0) return result;

    let creds: YfCreds;
    try { creds = await this.getCreds(); } catch { return result; }

    for (let i = 0; i < misses.length; i += CONCURRENCY) {
      const chunk = misses.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (symbol) => {
          try {
            const data = await this.fetchSymbol(symbol, creds);
            cache.set(`yf:${symbol}`, { expiresAt: now + ttlMs(), data });
            result[symbol] = data;
          } catch {
            result[symbol] = {};
          }
        })
      );
    }
    return result;
  }

  private async getCreds(): Promise<YfCreds> {
    const now = Date.now();
    if (yfCreds && yfCreds.expiresAt > now) return yfCreds;

    const cookieRes = await fetch("https://fc.yahoo.com", {
      headers: { "user-agent": YF_UA },
      redirect: "follow"
    });
    const rawCookies: string[] =
      typeof (cookieRes.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === "function"
        ? (cookieRes.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
        : [cookieRes.headers.get("set-cookie") ?? ""].filter(Boolean);
    const cookie = rawCookies.map((c) => c.split(";")[0]).filter(Boolean).join("; ");

    const crumbRes = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "user-agent": YF_UA, "Cookie": cookie, "accept": "text/plain" }
    });
    if (!crumbRes.ok) throw new Error(`Yahoo Finance crumb failed: ${crumbRes.status}`);
    const crumb = (await crumbRes.text()).trim();
    if (!crumb || crumb.startsWith("{")) throw new Error("Invalid Yahoo Finance crumb");

    yfCreds = { cookie, crumb, expiresAt: now + YF_CRUMB_TTL_MS };
    return yfCreds;
  }

  private async fetchSymbol(symbol: string, creds: YfCreds): Promise<SymbolEnrichment> {
    const modules = "summaryDetail,defaultKeyStatistics,financialData,assetProfile";
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=${modules}&crumb=${encodeURIComponent(creds.crumb)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetchWithRetry(url, {
        headers: { "user-agent": YF_UA, "Cookie": creds.cookie, "accept": "application/json" },
        cache: "no-store",
        signal: controller.signal
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { quoteSummary?: { result?: Array<Record<string, unknown>> } };
      const r = json?.quoteSummary?.result?.[0] as Record<string, unknown> | undefined;
      if (!r) return {};

      const sd = (r.summaryDetail ?? {}) as Record<string, { raw?: number }>;
      const ks = (r.defaultKeyStatistics ?? {}) as Record<string, { raw?: number }>;
      const fd = (r.financialData ?? {}) as Record<string, { raw?: number } | string>;
      const ap = (r.assetProfile ?? {}) as Record<string, unknown>;

      const rawPe = (sd.trailingPE as { raw?: number })?.raw;
      const rawDiv = (sd.trailingAnnualDividendYield as { raw?: number })?.raw;
      const rawEps = (ks.trailingEps as { raw?: number })?.raw;
      const rawRecMean = (fd.recommendationMean as { raw?: number })?.raw;
      const rawPb = (ks.priceToBook as { raw?: number })?.raw;
      const rawShortFloat = (ks.shortPercentOfFloat as { raw?: number })?.raw;
      const rawBeta = (ks.beta as { raw?: number })?.raw;
      const raw52High = (sd.fiftyTwoWeekHigh as { raw?: number })?.raw;
      const raw52Low = (sd.fiftyTwoWeekLow as { raw?: number })?.raw;
      const rawDebtToEquity = (fd.debtToEquity as { raw?: number })?.raw;
      const rawEarningsGrowth = (fd.earningsGrowth as { raw?: number })?.raw;
      const rawFcf = (fd.freeCashflow as { raw?: number })?.raw;
      const rawMarketCap = (sd.marketCap as { raw?: number })?.raw;

      const peRatio = typeof rawPe === "number" && rawPe > 0 ? rawPe : undefined;
      // Yahoo returns yield as decimal fraction (0.0036 = 0.36%); store as percentage points.
      const dividendYield = typeof rawDiv === "number" && rawDiv >= 0 ? Math.round(rawDiv * 10000) / 100 : undefined;
      const eps = typeof rawEps === "number" ? rawEps : undefined;
      const pbRatio = typeof rawPb === "number" && rawPb > 0 ? rawPb : undefined;
      const shortPercentOfFloat = typeof rawShortFloat === "number" && rawShortFloat >= 0 ? Math.round(rawShortFloat * 10000) / 100 : undefined;
      const beta = typeof rawBeta === "number" ? rawBeta : undefined;
      const fiftyTwoWeekHigh = typeof raw52High === "number" ? raw52High : undefined;
      const fiftyTwoWeekLow = typeof raw52Low === "number" ? raw52Low : undefined;
      const debtToEquity = typeof rawDebtToEquity === "number" ? rawDebtToEquity : undefined;
      const epsGrowth = typeof rawEarningsGrowth === "number" ? rawEarningsGrowth : undefined;
      let fcfYield: number | undefined;
      if (typeof rawFcf === "number" && typeof rawMarketCap === "number" && rawMarketCap > 0) {
        fcfYield = Math.round((rawFcf / rawMarketCap) * 10000) / 100;
      }
      const sector = typeof ap.sector === "string" && ap.sector ? ap.sector : undefined;
      const industry = typeof ap.industry === "string" && ap.industry ? ap.industry : undefined;

      // Analyst rating comes from the 1–5 recommendation mean → blended by the cascade.
      let analystBySource: Record<string, AnalystRatingDetail> | undefined;
      if (typeof rawRecMean === "number" && rawRecMean > 0) {
        const score = analystScoreFromMean(rawRecMean);
        analystBySource = {
          [this.name]: { score: Math.round(score), label: labelFromAnalystScore(score), mean: Math.round(rawRecMean * 100) / 100 }
        };
      }

      return {
        ...(peRatio !== undefined && { peRatio }),
        ...(dividendYield !== undefined && { dividendYield }),
        ...(eps !== undefined && { eps }),
        ...(sector !== undefined && { sector }),
        ...(industry !== undefined && { industry }),
        ...(pbRatio !== undefined && { pbRatio }),
        ...(shortPercentOfFloat !== undefined && { shortPercentOfFloat }),
        ...(beta !== undefined && { beta }),
        ...(fiftyTwoWeekHigh !== undefined && { fiftyTwoWeekHigh }),
        ...(fiftyTwoWeekLow !== undefined && { fiftyTwoWeekLow }),
        ...(debtToEquity !== undefined && { debtToEquity }),
        ...(epsGrowth !== undefined && { epsGrowth }),
        ...(fcfYield !== undefined && { fcfYield }),
        ...(analystBySource !== undefined && { analystBySource })
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ── Finnhub provider ─────────────────────────────────────────────────────────

export function isTransientError(error: unknown): boolean {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  if (/\b429\b|rate limit|too many requests/i.test(message)) return true;
  if (/\btimeout\b|abort|network|fetch|conn|socket|eai_again|dns|504|502|503/i.test(message)) return true;
  return false;
}

export class FinnhubEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = "finnhub";
  readonly configured = true;
  private readonly base = "https://finnhub.io/api/v1";
  private readonly scope: CacheScope;

  constructor(
    private readonly apiKey: string,
    keySource: ApiKeySource = "env",
    private readonly userId?: string
  ) {
    this.scope = cacheScopeForKeySource(keySource, userId);
  }

  async enrich(symbols: string[]): Promise<Record<string, SymbolEnrichment>> {
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean).slice(0, maxSymbols());
    if (normalized.length === 0) return {};

    const now = Date.now();
    const consented = hasDataPoolConsent(this.userId ?? "local");
    const result: Record<string, SymbolEnrichment> = {};
    const misses: string[] = [];
    for (const symbol of normalized) {
      const cached = readEnrichmentCache("finnhub", symbol, this.userId, consented, now);
      if (cached) result[symbol] = cached.data;
      else misses.push(symbol);
    }

    const toDate = new Date(now).toISOString().split("T")[0];
    const fromDate = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    for (let i = 0; i < misses.length; i += CONCURRENCY) {
      const chunk = misses.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (symbol) => {
          try {
            // Run all Finnhub calls in parallel per symbol.
            const [newsRaw, quoteRaw, recRaw, profileRaw, metricRaw] = await Promise.allSettled([
              this.getJson(`${this.base}/company-news?symbol=${symbol}&from=${fromDate}&to=${toDate}&token=${this.apiKey}`),
              this.getJson(`${this.base}/quote?symbol=${symbol}&token=${this.apiKey}`),
              this.getJson(`${this.base}/stock/recommendation?symbol=${symbol}&token=${this.apiKey}`),
              this.getJson(`${this.base}/stock/profile2?symbol=${symbol}&token=${this.apiKey}`),
              this.getJson(`${this.base}/stock/metric?symbol=${symbol}&metric=all&token=${this.apiKey}`)
            ]);

            // News → headlines + fallback sentiment
            let headlines: string[] = [];
            let sentiment: number | undefined;
            if (newsRaw.status === "fulfilled" && Array.isArray(newsRaw.value)) {
              headlines = (newsRaw.value as Array<{ headline: string }>).slice(0, 5).map((n) => n.headline).filter(Boolean);
              if (headlines.length > 0) sentiment = scoreHeadlines(headlines);
            }

            // Quote → volume
            let volume: number | undefined;
            if (quoteRaw.status === "fulfilled") {
              const q = quoteRaw.value as Record<string, unknown>;
              if (typeof q?.v === "number" && q.v > 0) volume = q.v;
            }

            // Analyst recommendations → 0–100 score + label + counts (blended by the cascade)
            let analystBySource: Record<string, AnalystRatingDetail> | undefined;
            if (recRaw.status === "fulfilled" && Array.isArray(recRaw.value) && (recRaw.value as Record<string, unknown>[]).length > 0) {
              const latest = (recRaw.value as Record<string, unknown>[])[0];
              const counts = {
                strongBuy: num(latest.strongBuy),
                buy: num(latest.buy),
                hold: num(latest.hold),
                sell: num(latest.sell),
                strongSell: num(latest.strongSell)
              };
              const score = analystScoreFromCounts(counts);
              if (score !== undefined) {
                analystBySource = { [this.name]: { score: Math.round(score), label: labelFromAnalystScore(score), counts } };
              }
            }

            // Company profile → sector + industry + company name
            let sector: string | undefined;
            let industry: string | undefined;
            let companyName: string | undefined;
            if (profileRaw.status === "fulfilled") {
              const profile = profileRaw.value as Record<string, unknown>;
              if (profile?.finnhubIndustry) { sector = String(profile.finnhubIndustry); industry = String(profile.finnhubIndustry); }
              if (profile?.sector) sector = String(profile.sector);
              if (typeof profile?.name === "string" && profile.name.trim()) companyName = profile.name.trim();
            }

            // Basic financials → P/E, dividend yield, EPS, average volume
            let peRatio: number | undefined;
            let dividendYield: number | undefined;
            let eps: number | undefined;
            let volumeFromMetric: number | undefined;
            if (metricRaw.status === "fulfilled") {
              const metric = (metricRaw.value as { metric?: Record<string, unknown> })?.metric ?? {};
              const pe = metric.peBasicExclExtraTTM ?? metric.peTTM;
              if (typeof pe === "number" && pe > 0) peRatio = pe;
              const dy = metric.dividendYieldIndicatedAnnual ?? metric.dividendYieldAnnual;
              if (typeof dy === "number" && dy >= 0) dividendYield = dy;
              const epsVal = metric.epsBasicExclExtraItemsTTM ?? metric.epsAnnual;
              if (typeof epsVal === "number") eps = epsVal;
              // Average trading volume in millions (10-day avg preferred, fall back to 3-month).
              const avgVolM = metric["10DayAverageTradingVolume"] ?? metric["3MonthAverageTradingVolume"];
              if (typeof avgVolM === "number" && avgVolM > 0) volumeFromMetric = Math.round(avgVolM * 1_000_000);
            }

            // Prefer the current session volume; fall back to metric average when session volume is 0 (e.g. after hours).
            const resolvedVolume = (volume && volume > 0 ? volume : undefined) ?? volumeFromMetric;
            const data: SymbolEnrichment = {
              ...(sentiment !== undefined && { sentiment }),
              ...(headlines.length > 0 && { headlines }),
              ...(peRatio !== undefined && { peRatio }),
              ...(analystBySource !== undefined && { analystBySource }),
              ...(sector !== undefined && { sector }),
              ...(industry !== undefined && { industry }),
              ...(companyName !== undefined && { companyName }),
              ...(resolvedVolume !== undefined && { volume: resolvedVolume }),
              ...(dividendYield !== undefined && { dividendYield }),
              ...(eps !== undefined && { eps })
            };

            const promises = [newsRaw, quoteRaw, recRaw, profileRaw, metricRaw];
            const allRejected = promises.every((p) => p.status === "rejected");
            const hasTransientError = promises.some(
              (p) => p.status === "rejected" && isTransientError(p.reason)
            );
            const isEmpty = Object.keys(data).length === 0;

            if (allRejected || hasTransientError || isEmpty) {
              console.warn(
                `[data-providers] Finnhub enrichment for ${symbol} skipped caching: ` +
                `(allRejected=${allRejected}, hasTransientError=${hasTransientError}, isEmpty=${isEmpty})`
              );
            } else {
              writeEnrichmentCache("finnhub", symbol, this.scope, this.userId, data, now + ttlMs());
            }
            result[symbol] = data;
          } catch {
            result[symbol] = {}; // empty; later cascade tiers can still fill gaps.
          }
        })
      );
    }
    return result;
  }

  private async getJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetchWithRetry(url, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ── FMP stable API provider ───────────────────────────────────────────────────
// Supplies P/E (ratios-ttm) and analyst consensus (grades-consensus).
// Sector/industry/headlines are not available on the free plan.

export class FmpEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = "fmp";
  readonly configured = true;
  private readonly base = "https://financialmodelingprep.com/stable";
  private readonly scope: CacheScope;

  constructor(
    private readonly apiKey: string,
    keySource: ApiKeySource = "env",
    private readonly userId?: string
  ) {
    this.scope = cacheScopeForKeySource(keySource, userId);
  }

  async enrich(symbols: string[]): Promise<Record<string, SymbolEnrichment>> {
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean).slice(0, maxSymbols());
    if (normalized.length === 0) return {};

    const now = Date.now();
    const consented = hasDataPoolConsent(this.userId ?? "local");
    const result: Record<string, SymbolEnrichment> = {};
    const misses: string[] = [];
    for (const symbol of normalized) {
      const cached = readEnrichmentCache("fmp", symbol, this.userId, consented, now);
      if (cached) result[symbol] = cached.data;
      else misses.push(symbol);
    }

    for (let i = 0; i < misses.length; i += CONCURRENCY) {
      const chunk = misses.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (symbol) => {
          const [peRaw, consensusRaw, insiderRaw, senateRaw] = await Promise.allSettled([
            this.getJson(`${this.base}/ratios-ttm?symbol=${symbol}&apikey=${this.apiKey}`),
            this.getJson(`${this.base}/grades-consensus?symbol=${symbol}&apikey=${this.apiKey}`),
            this.getJson(`https://financialmodelingprep.com/api/v4/insider-trading?symbol=${symbol}&apikey=${this.apiKey}`),
            this.getJson(`https://financialmodelingprep.com/api/v4/senate-trading?symbol=${symbol}&apikey=${this.apiKey}`)
          ]);

          let peRatio: number | undefined;
          if (peRaw.status === "fulfilled" && Array.isArray(peRaw.value)) {
            const pe = Number((peRaw.value as Array<Record<string, unknown>>)[0]?.priceToEarningsRatioTTM);
            if (Number.isFinite(pe) && pe > 0) peRatio = pe;
          }

          // Analyst grades-consensus → 0–100 score + label + counts (blended by the cascade).
          // FMP does not provide news, so it contributes no sentiment.
          let analystBySource: Record<string, AnalystRatingDetail> | undefined;
          if (consensusRaw.status === "fulfilled" && Array.isArray(consensusRaw.value)) {
            const row = (consensusRaw.value as Array<Record<string, unknown>>)[0];
            if (row) {
              const counts = {
                strongBuy: num(row.strongBuy),
                buy: num(row.buy),
                hold: num(row.hold),
                sell: num(row.sell),
                strongSell: num(row.strongSell)
              };
              const score = analystScoreFromCounts(counts);
              if (score !== undefined) {
                analystBySource = { [this.name]: { score: Math.round(score), label: labelFromAnalystScore(score), counts } };
              }
            }
          }

          let insiderSentiment: number | undefined;
          if (insiderRaw.status === "fulfilled" && Array.isArray(insiderRaw.value)) {
            const trades = insiderRaw.value as Array<Record<string, unknown>>;
            let buys = 0;
            let sells = 0;
            for (const trade of trades.slice(0, 100)) {
              const type = String(trade.transactionType || "").toLowerCase();
              const acqDisp = String(trade.acquistionOrDisposition || "").toLowerCase();
              if (type.includes("buy") || type.includes("purchase") || acqDisp === "a") buys++;
              else if (type.includes("sell") || type.includes("sale") || acqDisp === "d") sells++;
            }
            const total = buys + sells;
            if (total > 0) {
              insiderSentiment = Math.round((buys / total) * 100);
            }
          }

          let senateTrades: number | undefined;
          if (senateRaw.status === "fulfilled" && Array.isArray(senateRaw.value)) {
            const trades = senateRaw.value as Array<Record<string, unknown>>;
            let net = 0;
            for (const trade of trades.slice(0, 100)) {
              const type = String(trade.type || "").toLowerCase();
              if (type.includes("purchase")) net++;
              else if (type.includes("sale")) net--;
            }
            if (trades.length > 0) senateTrades = net;
          }

          const data: SymbolEnrichment = {
            ...(peRatio !== undefined && { peRatio }),
            ...(analystBySource !== undefined && { analystBySource }),
            ...(insiderSentiment !== undefined && { insiderSentiment }),
            ...(senateTrades !== undefined && { senateTrades })
          };

          const promises = [peRaw, consensusRaw, insiderRaw, senateRaw];
          const allRejected = promises.every((p) => p.status === "rejected");
          const hasTransientError = promises.some(
            (p) => p.status === "rejected" && isTransientError(p.reason)
          );
          const isEmpty = Object.keys(data).length === 0;

          if (allRejected || hasTransientError || isEmpty) {
            console.warn(
              `[data-providers] FMP enrichment for ${symbol} skipped caching: ` +
              `(allRejected=${allRejected}, hasTransientError=${hasTransientError}, isEmpty=${isEmpty})`
            );
          } else {
            writeEnrichmentCache("fmp", symbol, this.scope, this.userId, data, now + ttlMs());
          }
          result[symbol] = data;
        })
      );
    }
    return result;
  }

  private async getJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetchWithRetry(url, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ── Alpha Vantage provider ───────────────────────────────────────────────────

export class AlphaVantageEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = "alpha-vantage";
  readonly configured = true;
  private readonly base = "https://www.alphavantage.co/query";
  private readonly scope: CacheScope;

  constructor(
    private readonly apiKey: string,
    keySource: ApiKeySource = "env",
    private readonly userId?: string
  ) {
    this.scope = cacheScopeForKeySource(keySource, userId);
  }

  async enrich(symbols: string[]): Promise<Record<string, SymbolEnrichment>> {
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean).slice(0, maxSymbols());
    if (normalized.length === 0) return {};

    const now = Date.now();
    const consented = hasDataPoolConsent(this.userId ?? "local");
    const result: Record<string, SymbolEnrichment> = {};
    const misses: string[] = [];
    for (const symbol of normalized) {
      const cached = readEnrichmentCache("alphavantage", symbol, this.userId, consented, now);
      if (cached) result[symbol] = cached.data;
      else misses.push(symbol);
    }

    for (let i = 0; i < misses.length; i += CONCURRENCY) {
      const chunk = misses.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (symbol) => {
          try {
            const url = `${this.base}?function=NEWS_SENTIMENT&tickers=${symbol}&apikey=${this.apiKey}`;
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 6000);
            let payload: Record<string, unknown>;
            try {
              const response = await fetchWithRetry(url, { cache: "no-store", signal: controller.signal });
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              payload = await response.json() as Record<string, unknown>;
              
              if (payload && (payload.Note || payload.Information || payload["Error Message"])) {
                const msg = String(payload.Note || payload.Information || payload["Error Message"]);
                throw new Error(`Alpha Vantage API warning/error: ${msg}`);
              }
            } finally {
              clearTimeout(timeout);
            }

            let sentiment: number | undefined;
            let headlines: string[] = [];

            if (payload && Array.isArray(payload.feed)) {
              const feed = payload.feed as Array<Record<string, unknown>>;
              
              // Extract headlines
              headlines = feed
                .slice(0, 5)
                .map(item => typeof item.title === "string" ? item.title.trim() : "")
                .filter(Boolean);

              // Calculate average sentiment score from ticker_sentiment
              let scoreSum = 0;
              let scoreCount = 0;
              
              for (const item of feed.slice(0, 20)) { // look at top 20 news items
                const tickerArr = Array.isArray(item.ticker_sentiment) ? item.ticker_sentiment : [];
                const targetTicker = tickerArr.find((t: { ticker?: string }) => t.ticker === symbol);
                if (targetTicker && typeof targetTicker.ticker_sentiment_score === "string") {
                  const score = Number(targetTicker.ticker_sentiment_score);
                  if (Number.isFinite(score)) {
                    scoreSum += score;
                    scoreCount++;
                  }
                }
              }

              if (scoreCount > 0) {
                const avgScore = scoreSum / scoreCount;
                // Alpha vantage sentiment ranges roughly [-0.35, 0.35]. Map it to 0-100.
                sentiment = Math.max(0, Math.min(100, Math.round(50 + (avgScore * 100))));
              }
            }

            const data: SymbolEnrichment = {
              ...(sentiment !== undefined && { sentiment }),
              ...(headlines.length > 0 && { headlines })
            };

            // AV only writes to cache on a valid feed (warning/error detection above throws).
            writeEnrichmentCache("alphavantage", symbol, this.scope, this.userId, data, now + ttlMs());
            result[symbol] = data;
          } catch {
            result[symbol] = {};
          }
        })
      );
    }
    return result;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function firstNumber(row: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = row[key];
    if (value === null || value === undefined || value === "") continue;
    const parsed = typeof value === "number" ? value : Number(String(value).replace(/[$,%\s,]/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function firstString(row: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function normalizePercent(value: number): number {
  const pct = Math.abs(value) <= 1 ? value * 100 : value;
  return Math.round(pct * 100) / 100;
}

// Lightweight headline sentiment proxy: counts positive vs negative finance keywords.
const POSITIVE_WORDS = ["beat", "beats", "surge", "surges", "soar", "soars", "rally", "rallies", "upgrade", "upgraded", "record", "growth", "gains", "jumps", "outperform", "buy", "bullish", "strong", "raises", "profit", "wins"];
const NEGATIVE_WORDS = ["miss", "misses", "plunge", "plunges", "drop", "drops", "fall", "falls", "downgrade", "downgraded", "cut", "cuts", "loss", "losses", "warning", "warns", "lawsuit", "probe", "bearish", "weak", "slump", "decline", "fraud", "recall"];

export function scoreHeadlines(headlines: string[]): number {
  let positive = 0;
  let negative = 0;
  for (const headline of headlines) {
    for (const word of headline.toLowerCase().split(/[^a-z]+/)) {
      if (POSITIVE_WORDS.includes(word)) positive += 1;
      if (NEGATIVE_WORDS.includes(word)) negative += 1;
    }
  }
  if (positive + negative === 0) return 50;
  // Damped tanh on the NET signal so a few positive words no longer peg the score at 100.
  // net 1→66, 2→74, 3→81, 5→91 … and it never reaches a hard 0/100 (clamped to 5–95).
  const net = positive - negative;
  const raw = 50 + 50 * Math.tanh(net / 3.5);
  return Math.max(5, Math.min(95, Math.round(raw)));
}

export function clearEnrichmentCache(): void {
  cache.clear();
  yfCreds = null;
}

export class FintechStudiosEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = "fintechstudios";
  readonly configured = true;
  private readonly base: string;
  private readonly scope: CacheScope;

  constructor(
    private readonly apiKey: string,
    keySource: ApiKeySource = "env",
    private readonly userId?: string
  ) {
    this.base = process.env.FINTECH_STUDIOS_BASE_URL ?? "https://studio.fintechstudios.com/api/v1";
    this.scope = cacheScopeForKeySource(keySource, userId);
  }

  async enrich(symbols: string[]): Promise<Record<string, SymbolEnrichment>> {
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean).slice(0, maxSymbols());
    if (normalized.length === 0) return {};

    const now = Date.now();
    const consented = hasDataPoolConsent(this.userId ?? "local");
    const result: Record<string, SymbolEnrichment> = {};
    const misses: string[] = [];
    for (const symbol of normalized) {
      const cached = readEnrichmentCache("fintechstudios", symbol, this.userId, consented, now);
      if (cached) {
        result[symbol] = cached.data;
      } else {
        misses.push(symbol);
      }
    }

    if (misses.length === 0) return result;

    for (let i = 0; i < misses.length; i += CONCURRENCY) {
      const chunk = misses.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (symbol) => {
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 8000);
            let headlines: string[] = [];
            let sentiment: number | undefined;

            try {
              const url = `${this.base.replace(/\/$/, "")}/search`;
              const response = await fetchWithRetry(url, {
                method: "POST",
                headers: {
                  "Authorization": `Bearer ${this.apiKey}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  query: `${symbol} stock`,
                  limit: 5,
                }),
                cache: "no-store",
                signal: controller.signal,
              });

              if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
              }

              const json = (await response.json()) as {
                data?: {
                  articles?: Array<{ title?: string }>;
                };
              };

              const articles = json.data?.articles || [];
              headlines = articles
                .map((a) => (typeof a.title === "string" ? a.title.trim() : ""))
                .filter(Boolean)
                .slice(0, 5);

              if (headlines.length > 0) {
                sentiment = scoreHeadlines(headlines);
              }
            } finally {
              clearTimeout(timeout);
            }

            const data: SymbolEnrichment = {
              ...(headlines.length > 0 && { headlines }),
              ...(sentiment !== undefined && { sentiment }),
            };

            if (headlines.length > 0) {
              writeEnrichmentCache("fintechstudios", symbol, this.scope, this.userId, data, now + ttlMs());
            }
            result[symbol] = data;
          } catch (err) {
            console.error(`[data-providers] Fintech Studios error for ${symbol}:`, err);
            result[symbol] = {};
          }
        })
      );
    }

    return result;
  }
}
