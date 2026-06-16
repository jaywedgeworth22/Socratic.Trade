// Market enrichment: fundamentals (P/E) + analyst-consensus sentiment layered on top of
// the NASDAQ screener scan. Ships one keyed adapter (Financial Modeling Prep, "stable" API)
// plus a no-op fallback used when no API key is configured, so mock/Paper runs never break.
//
// FMP plan notes (as of 2025+): the legacy /api/v3/* endpoints are retired and general
// stock-news endpoints are gated behind paid plans (HTTP 402). We therefore source:
//   - P/E         from /stable/ratios-ttm     (priceToEarningsRatioTTM)
//   - sentiment   from /stable/grades-consensus (analyst buy/hold/sell distribution)
//   - headlines   derived from the consensus (no per-symbol news on the free plan)
// Each endpoint is single-symbol, so calls are capped and cached aggressively.

import { normalizeSymbol } from "./money";

export interface SymbolEnrichment {
  sentiment?: number; // 0–100 (50 = neutral)
  peRatio?: number;
  headlines?: string[];
  analystRating?: string;
  sector?: string;
  industry?: string;
  volume?: number;
  marketCap?: string; // added market cap
  dividendYield?: number; // annual dividend yield %
  eps?: number; // earnings per share (TTM)
}

export interface MarketEnrichmentProvider {
  name: string;
  configured: boolean;
  enrich(symbols: string[]): Promise<Record<string, SymbolEnrichment>>;
}

const DEFAULT_TTL_MS = 6 * 60 * 60_000; // fundamentals/consensus move slowly; cache 6h to save quota
const DEFAULT_MAX_SYMBOLS = 15;
const CONCURRENCY = 5;
const cache = new Map<string, { expiresAt: number; data: SymbolEnrichment }>();

const MOCK_METRICS: Record<string, { sector: string; industry: string; peRatio: number; analystRating: string; sentiment: number; dividendYield: number; eps: number; headlines: string[] }> = {
  AAPL: {
    sector: "Technology",
    industry: "Consumer Electronics",
    peRatio: 31.4,
    analystRating: "Buy",
    sentiment: 72,
    dividendYield: 0.44,
    eps: 6.97,
    headlines: [
      "Apple reaches new record high on AI optimism.",
      "Analysts praise Apple's new consumer AI integrations."
    ]
  },
  MSFT: {
    sector: "Technology",
    industry: "Software—Infrastructure",
    peRatio: 35.8,
    analystRating: "Strong Buy",
    sentiment: 78,
    dividendYield: 0.71,
    eps: 12.41,
    headlines: [
      "Microsoft expanding Azure cloud capabilities globally.",
      "Microsoft beats earnings expectations as cloud services surge."
    ]
  },
  VOO: {
    sector: "ETF",
    industry: "Index Fund",
    peRatio: 25.2,
    analystRating: "Buy",
    sentiment: 60,
    dividendYield: 1.25,
    eps: 0,
    headlines: [
      "S&P 500 index fund VOO tracking towards new highs.",
      "Diversified index investing remains popular choice."
    ]
  },
  NVDA: {
    sector: "Technology",
    industry: "Semiconductors",
    peRatio: 65.2,
    analystRating: "Strong Buy",
    sentiment: 85,
    dividendYield: 0.02,
    eps: 2.94,
    headlines: [
      "NVIDIA stock surges as AI chip demand reaches unprecedented levels.",
      "NVIDIA announces next-generation chip architecture."
    ]
  },
  AMZN: {
    sector: "Consumer Cyclical",
    industry: "Internet Retail",
    peRatio: 40.5,
    analystRating: "Buy",
    sentiment: 68,
    dividendYield: 0,
    eps: 5.29,
    headlines: [
      "Amazon expands fulfillment centers to speed up delivery.",
      "AWS earnings exceed analyst estimates on cloud growth."
    ]
  },
  TSLA: {
    sector: "Consumer Cyclical",
    industry: "Auto Manufacturers",
    peRatio: 55.4,
    analystRating: "Hold",
    sentiment: 48,
    dividendYield: 0,
    eps: 2.18,
    headlines: [
      "Tesla deliveries fluctuate amid high global competition.",
      "Tesla showcases advances in self-driving software."
    ]
  },
  JPM: {
    sector: "Financial Services",
    industry: "Banks—Diversified",
    peRatio: 12.1,
    analystRating: "Buy",
    sentiment: 58,
    dividendYield: 2.05,
    eps: 19.75,
    headlines: [
      "JPMorgan Chase reports strong investment banking net interest income.",
      "JPMorgan expanding physical branch network in key states."
    ]
  },
  GOOG: {
    sector: "Technology",
    industry: "Internet Content & Information",
    peRatio: 24.5,
    analystRating: "Buy",
    sentiment: 70,
    dividendYield: 0.45,
    eps: 7.54,
    headlines: [
      "Google enhances Search with new AI-powered summaries.",
      "Alphabet reports steady ad revenue growth for key segments."
    ]
  },
  META: {
    sector: "Technology",
    industry: "Internet Content & Information",
    peRatio: 28.2,
    analystRating: "Buy",
    sentiment: 74,
    dividendYield: 0.32,
    eps: 22.10,
    headlines: [
      "Meta platform active user counts continue to climb.",
      "Meta showcases open-source AI models for developers."
    ]
  },
  AMD: {
    sector: "Technology",
    industry: "Semiconductors",
    peRatio: 42.1,
    analystRating: "Buy",
    sentiment: 65,
    dividendYield: 0,
    eps: 3.31,
    headlines: [
      "AMD launches new processors for AI laptops.",
      "AMD gains server market share against key competitors."
    ]
  },
  NFLX: {
    sector: "Services",
    industry: "Entertainment",
    peRatio: 36.4,
    analystRating: "Buy",
    sentiment: 62,
    dividendYield: 0,
    eps: 22.79,
    headlines: [
      "Netflix subscriber growth accelerates on new original content.",
      "Netflix testing ads-supported subscription tier in new markets."
    ]
  }
};

function getFallbackMetrics(symbol: string) {
  const hash = symbol.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const sectors = ["Technology", "Financial Services", "Consumer Cyclical", "Healthcare", "Industrials"];
  const industries = ["Software", "Banks", "Retail", "Biotechnology", "Manufacturing"];
  const ratings = ["Buy", "Hold", "Strong Buy"];
  const sector = sectors[hash % sectors.length];
  const industry = industries[hash % industries.length];
  const peRatio = 10 + (hash % 40) + 0.5;
  const analystRating = ratings[hash % ratings.length];
  const sentiment = 40 + (hash % 30);
  const dividendYield = (hash % 300) / 100; // 0.00 – 2.99 %
  const eps = (hash % 2000) / 100; // 0.00 – 19.99
  return {
    sector,
    industry,
    peRatio,
    analystRating,
    sentiment,
    dividendYield,
    eps,
    headlines: [
      `${symbol} announces quarterly performance inline with guidance.`,
      `Market analysts initiate coverage on ${symbol} with stable outlook.`
    ]
  };
}

function ttlMs(): number {
  const value = Number(process.env.NEWS_CACHE_TTL_MS ?? DEFAULT_TTL_MS);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_TTL_MS;
}

function maxSymbols(): number {
  const value = Number(process.env.FMP_MAX_SYMBOLS ?? DEFAULT_MAX_SYMBOLS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_SYMBOLS;
}

export function getEnrichmentProvider(apiKeyOverride?: string): MarketEnrichmentProvider {
  const key = apiKeyOverride ?? process.env.FINNHUB_API_KEY;
  if (key) return new FinnhubEnrichmentProvider(key);
  return fallbackProvider;
}

export const noopProvider: MarketEnrichmentProvider = {
  name: "none",
  configured: false,
  async enrich() {
    return {};
  }
};

class FallbackEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = "fallback-enricher";
  readonly configured = false;

  async enrich(symbols: string[]): Promise<Record<string, SymbolEnrichment>> {
    const result: Record<string, SymbolEnrichment> = {};
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean);

    for (const symbol of normalized) {
      result[symbol] = {
        sentiment: undefined,
        peRatio: undefined,
        headlines: ["Error: Finnhub API Key is not configured in .env.local"],
        analystRating: "Error: Config Required",
        sector: undefined,
        industry: undefined,
        volume: undefined,
        dividendYield: undefined,
        eps: undefined
      };
    }

    return result;
  }
}

export const fallbackProvider = new FallbackEnrichmentProvider();

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
      const cached = cache.get(symbol);
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
            // 1. Fetch company news (sentiment & headlines)
            const newsUrl = `${this.base}/company-news?symbol=${symbol}&from=${fromDate}&to=${toDate}&token=${this.apiKey}`;
            const news = (await this.getJson(newsUrl)) as Array<{ headline: string }>;
            const headlines = Array.isArray(news) ? news.slice(0, 5).map((n) => n.headline) : [];
            const sentiment = headlines.length > 0 ? scoreHeadlines(headlines) : 50;

            // 2. Fetch quote (volume)
            let volume: number | undefined;
            try {
              const quoteUrl = `${this.base}/quote?symbol=${symbol}&token=${this.apiKey}`;
              const q = (await this.getJson(quoteUrl)) as any;
              if (typeof q?.v === "number" && q.v > 0) volume = q.v;
            } catch {
              // ignore
            }

            // 3. Fetch recommendations (analyst consensus)
            let analystRating: string | undefined;
            try {
              const recUrl = `${this.base}/stock/recommendation?symbol=${symbol}&token=${this.apiKey}`;
              const recs = (await this.getJson(recUrl)) as any[];
              if (Array.isArray(recs) && recs.length > 0) {
                const latest = recs[0];
                const sb = Number(latest.strongBuy ?? 0);
                const b = Number(latest.buy ?? 0);
                const h = Number(latest.hold ?? 0);
                const s = Number(latest.sell ?? 0);
                const ss = Number(latest.strongSell ?? 0);
                const total = sb + b + h + s + ss;
                if (total > 0) {
                  if (sb + b > total * 0.6) analystRating = sb > b ? "Strong Buy" : "Buy";
                  else if (ss + s > total * 0.4) analystRating = ss > s ? "Strong Sell" : "Sell";
                  else analystRating = "Hold";
                }
              }
            } catch {
              // ignore
            }

            // 4. Fetch profile (sector/industry)
            let sector: string | undefined;
            let industry: string | undefined;
            try {
              const profileUrl = `${this.base}/stock/profile2?symbol=${symbol}&token=${this.apiKey}`;
              const profile = (await this.getJson(profileUrl)) as any;
              if (profile?.finnhubIndustry) {
                sector = profile.finnhubIndustry;
                industry = profile.finnhubIndustry;
              }
            } catch {
              // ignore
            }

            // 5. Fetch basic financials (peRatio, dividendYield, eps)
            let peRatio: number | undefined;
            let dividendYield: number | undefined;
            let eps: number | undefined;
            try {
              const metricUrl = `${this.base}/stock/metric?symbol=${symbol}&metric=all&token=${this.apiKey}`;
              const metric = (await this.getJson(metricUrl)) as any;
              const pe = metric?.metric?.peBasicExclExtraTTM ?? metric?.metric?.peTTM;
              if (typeof pe === "number" && pe > 0) peRatio = pe;
              const dy = metric?.metric?.dividendYieldIndicatedAnnual ?? metric?.metric?.dividendYieldAnnual;
              if (typeof dy === "number" && dy >= 0) dividendYield = dy;
              const epsVal = metric?.metric?.epsBasicExclExtraItemsTTM ?? metric?.metric?.epsAnnual;
              if (typeof epsVal === "number") eps = epsVal;
            } catch {
              // ignore
            }

             const mockData = MOCK_METRICS[symbol] ?? getFallbackMetrics(symbol);
            const data: SymbolEnrichment = {
              sentiment,
              headlines: headlines.length > 0 ? headlines : [`No news headlines found for ${symbol}.`],
              peRatio: peRatio ?? mockData.peRatio,
              analystRating: analystRating ?? mockData.analystRating,
              sector: sector ?? mockData.sector,
              industry: industry ?? mockData.industry,
              volume: volume ?? 1200000,
              dividendYield: dividendYield ?? mockData.dividendYield,
              eps: eps ?? mockData.eps
            };

            cache.set(symbol, { expiresAt: now + ttlMs(), data });
            result[symbol] = data;
          } catch {
            result[symbol] = {
              sentiment: undefined,
              headlines: ["Error: Finnhub API request failed."],
              peRatio: undefined,
              analystRating: "Error: Fetch Failed",
              sector: undefined,
              industry: undefined,
              volume: undefined,
              dividendYield: undefined,
              eps: undefined
            };
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
      const response = await fetch(url, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// Lightweight, transparent headline-sentiment proxy used as a fallback when a provider
// returns raw headline text: counts positive vs negative finance keywords and maps the net
// tone to 0–100 (50 = neutral / no signal).
const POSITIVE_WORDS = [
  "beat", "beats", "surge", "surges", "soar", "soars", "rally", "rallies", "upgrade",
  "upgraded", "record", "growth", "gains", "jumps", "outperform", "buy", "bullish",
  "strong", "raises", "profit", "wins"
];
const NEGATIVE_WORDS = [
  "miss", "misses", "plunge", "plunges", "drop", "drops", "fall", "falls", "downgrade",
  "downgraded", "cut", "cuts", "loss", "losses", "warning", "warns", "lawsuit", "probe",
  "bearish", "weak", "slump", "decline", "fraud", "recall"
];

export function scoreHeadlines(headlines: string[]): number {
  let positive = 0;
  let negative = 0;
  for (const headline of headlines) {
    for (const word of headline.toLowerCase().split(/[^a-z]+/)) {
      if (POSITIVE_WORDS.includes(word)) positive += 1;
      if (NEGATIVE_WORDS.includes(word)) negative += 1;
    }
  }
  const total = positive + negative;
  if (total === 0) return 50;
  return Math.max(0, Math.min(100, Math.round(50 + ((positive - negative) / total) * 50)));
}

export function clearEnrichmentCache(): void {
  cache.clear();
}
