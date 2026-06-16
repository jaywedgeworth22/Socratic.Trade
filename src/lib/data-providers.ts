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

// Per-source analyst breakdown so the Rating column can blend across providers and
// the tooltip can show each provider's individual read.
export interface AnalystRatingDetail {
  score: number;   // 0–100 (Strong Buy = 100 … Strong Sell = 0)
  label: string;   // Strong Buy / Buy / Hold / Sell / Strong Sell
  counts?: { strongBuy: number; buy: number; hold: number; sell: number; strongSell: number };
  mean?: number;   // analyst mean (1–5) when the source reports one instead of counts
}

export interface SymbolEnrichment {
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
  // Which provider supplied each scalar field (filled by the cascade).
  sources?: Partial<Record<EnrichmentSourcedField, string>>;
  // Each provider's own analyst read, keyed by provider name (for the Rating tooltip).
  analystBySource?: Record<string, AnalystRatingDetail>;
}

export type EnrichmentSourcedField =
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
  | "insiderSentiment";

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
// Cover the full scan candidate set (MARKET_SCAN_LIMIT, default 30) so every row the
// dashboard displays is enriched — otherwise symbols that climb in rank after enrichment
// would render blank. The 6h cache means only the first run is heavy.
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

export function getEnrichmentProvider(): MarketEnrichmentProvider {
  const providers: MarketEnrichmentProvider[] = [];
  if (process.env.FINNHUB_API_KEY) providers.push(new FinnhubEnrichmentProvider(process.env.FINNHUB_API_KEY));
  if (process.env.FMP_API_KEY) providers.push(new FmpEnrichmentProvider(process.env.FMP_API_KEY));
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
export const fallbackProvider = mockEnrichmentProvider;

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

      base.sources = sources;
      merged[symbol] = base;
    }
    return merged;
  }
}

// Marker set so takeScalar only stamps fields that are actually sourced (not headlines/analyst).
const EMPTY_SOURCED: Record<EnrichmentSourcedField, true> = {
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
  insiderSentiment: true
};

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
      const r = json?.quoteSummary?.result?.[0] as Record<string, any> | undefined;
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

      const peRatio = typeof rawPe === "number" && rawPe > 0 ? rawPe : undefined;
      // Yahoo returns yield as decimal fraction (0.0036 = 0.36%); store as percentage points.
      const dividendYield = typeof rawDiv === "number" && rawDiv >= 0 ? Math.round(rawDiv * 10000) / 100 : undefined;
      const eps = typeof rawEps === "number" ? rawEps : undefined;
      const pbRatio = typeof rawPb === "number" && rawPb > 0 ? rawPb : undefined;
      const shortPercentOfFloat = typeof rawShortFloat === "number" && rawShortFloat >= 0 ? Math.round(rawShortFloat * 10000) / 100 : undefined;
      const beta = typeof rawBeta === "number" ? rawBeta : undefined;
      const fiftyTwoWeekHigh = typeof raw52High === "number" ? raw52High : undefined;
      const fiftyTwoWeekLow = typeof raw52Low === "number" ? raw52Low : undefined;
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
        ...(analystBySource !== undefined && { analystBySource })
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ── Finnhub provider ─────────────────────────────────────────────────────────

class FinnhubEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = "finnhub";
  readonly configured = true;
  private readonly base = "https://finnhub.io/api/v1";

  constructor(private readonly apiKey: string) {}

  async enrich(symbols: string[]): Promise<Record<string, SymbolEnrichment>> {
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean).slice(0, maxSymbols());
    if (normalized.length === 0) return {};

    const now = Date.now();
    const result: Record<string, SymbolEnrichment> = {};
    const misses: string[] = [];
    for (const symbol of normalized) {
      const cached = cache.get(`finnhub:${symbol}`);
      if (cached && cached.expiresAt > now) result[symbol] = cached.data;
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
            const insiderFrom = new Date(now - 180 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]; // Last 6 months
            const [newsRaw, quoteRaw, recRaw, profileRaw, metricRaw, insiderRaw] = await Promise.allSettled([
              this.getJson(`${this.base}/company-news?symbol=${symbol}&from=${fromDate}&to=${toDate}&token=${this.apiKey}`),
              this.getJson(`${this.base}/quote?symbol=${symbol}&token=${this.apiKey}`),
              this.getJson(`${this.base}/stock/recommendation?symbol=${symbol}&token=${this.apiKey}`),
              this.getJson(`${this.base}/stock/profile2?symbol=${symbol}&token=${this.apiKey}`),
              this.getJson(`${this.base}/stock/metric?symbol=${symbol}&metric=all&token=${this.apiKey}`),
              this.getJson(`${this.base}/stock/insider-sentiment?symbol=${symbol}&from=${insiderFrom}&to=${toDate}&token=${this.apiKey}`)
            ]);

            // News → sentiment + headlines
            let headlines: string[] = [];
            let sentiment: number | undefined;
            if (newsRaw.status === "fulfilled" && Array.isArray(newsRaw.value)) {
              headlines = (newsRaw.value as Array<{ headline: string }>).slice(0, 5).map((n) => n.headline).filter(Boolean);
              if (headlines.length > 0) sentiment = scoreHeadlines(headlines);
            }

            // Quote → volume
            let volume: number | undefined;
            if (quoteRaw.status === "fulfilled") {
              const q = quoteRaw.value as any;
              if (typeof q?.v === "number" && q.v > 0) volume = q.v;
            }

            // Analyst recommendations → 0–100 score + label + counts (blended by the cascade)
            let analystBySource: Record<string, AnalystRatingDetail> | undefined;
            if (recRaw.status === "fulfilled" && Array.isArray(recRaw.value) && (recRaw.value as any[]).length > 0) {
              const latest = (recRaw.value as any[])[0];
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
              const profile = profileRaw.value as any;
              if (profile?.finnhubIndustry) { sector = profile.finnhubIndustry; industry = profile.finnhubIndustry; }
              if (profile?.sector) sector = profile.sector;
              if (typeof profile?.name === "string" && profile.name.trim()) companyName = profile.name.trim();
            }

            // Basic financials → P/E, dividend yield, EPS, average volume
            let peRatio: number | undefined;
            let dividendYield: number | undefined;
            let eps: number | undefined;
            let volumeFromMetric: number | undefined;
            if (metricRaw.status === "fulfilled") {
              const metric = (metricRaw.value as any)?.metric ?? {};
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

            let insiderSentiment: number | undefined;
            if (insiderRaw.status === "fulfilled" && (insiderRaw.value as any)?.data) {
              const dataArr = (insiderRaw.value as any).data as any[];
              if (dataArr.length > 0) {
                const avgMspr = dataArr.reduce((sum, d) => sum + num(d.mspr), 0) / dataArr.length;
                insiderSentiment = Math.max(0, Math.min(100, Math.round(((avgMspr + 100) / 200) * 100)));
              }
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
              ...(eps !== undefined && { eps }),
              ...(insiderSentiment !== undefined && { insiderSentiment })
            };

            cache.set(`finnhub:${symbol}`, { expiresAt: now + ttlMs(), data });
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

class FmpEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = "fmp";
  readonly configured = true;
  private readonly base = "https://financialmodelingprep.com/stable";

  constructor(private readonly apiKey: string) {}

  async enrich(symbols: string[]): Promise<Record<string, SymbolEnrichment>> {
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean).slice(0, maxSymbols());
    if (normalized.length === 0) return {};

    const now = Date.now();
    const result: Record<string, SymbolEnrichment> = {};
    const misses: string[] = [];
    for (const symbol of normalized) {
      const cached = cache.get(`fmp:${symbol}`);
      if (cached && cached.expiresAt > now) result[symbol] = cached.data;
      else misses.push(symbol);
    }

    for (let i = 0; i < misses.length; i += CONCURRENCY) {
      const chunk = misses.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (symbol) => {
          const [peRaw, consensusRaw] = await Promise.allSettled([
            this.getJson(`${this.base}/ratios-ttm?symbol=${symbol}&apikey=${this.apiKey}`),
            this.getJson(`${this.base}/grades-consensus?symbol=${symbol}&apikey=${this.apiKey}`)
          ]);

          let peRatio: number | undefined;
          if (peRaw.status === "fulfilled" && Array.isArray(peRaw.value)) {
            const pe = Number((peRaw.value as any[])[0]?.priceToEarningsRatioTTM);
            if (Number.isFinite(pe) && pe > 0) peRatio = pe;
          }

          // Analyst grades-consensus → 0–100 score + label + counts (blended by the cascade).
          // FMP does not provide news, so it contributes no sentiment.
          let analystBySource: Record<string, AnalystRatingDetail> | undefined;
          if (consensusRaw.status === "fulfilled" && Array.isArray(consensusRaw.value)) {
            const row = (consensusRaw.value as any[])[0];
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

          const data: SymbolEnrichment = {
            ...(peRatio !== undefined && { peRatio }),
            ...(analystBySource !== undefined && { analystBySource })
          };

          cache.set(`fmp:${symbol}`, { expiresAt: now + ttlMs(), data });
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
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
