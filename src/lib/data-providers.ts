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

function ttlMs(): number {
  const value = Number(process.env.NEWS_CACHE_TTL_MS ?? DEFAULT_TTL_MS);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_TTL_MS;
}

function maxSymbols(): number {
  const value = Number(process.env.FMP_MAX_SYMBOLS ?? DEFAULT_MAX_SYMBOLS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_SYMBOLS;
}

export function getEnrichmentProvider(): MarketEnrichmentProvider {
  if (process.env.FMP_API_KEY) return new FmpEnrichmentProvider(process.env.FMP_API_KEY);
  return noopProvider;
}

export const noopProvider: MarketEnrichmentProvider = {
  name: "none",
  configured: false,
  async enrich() {
    return {};
  }
};

class FmpEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = "financial-modeling-prep";
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
      const cached = cache.get(symbol);
      if (cached && cached.expiresAt > now) result[symbol] = cached.data;
      else misses.push(symbol);
    }

    for (let i = 0; i < misses.length; i += CONCURRENCY) {
      const chunk = misses.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (symbol) => {
          const [peRatio, consensus] = await Promise.all([this.fetchPeRatio(symbol), this.fetchConsensus(symbol)]);
          const data: SymbolEnrichment = {
            peRatio,
            sentiment: consensus?.sentiment,
            headlines: consensus?.headlines
          };
          cache.set(symbol, { expiresAt: now + ttlMs(), data });
          result[symbol] = data;
        })
      );
    }
    return result;
  }

  private async fetchPeRatio(symbol: string): Promise<number | undefined> {
    try {
      const rows = (await this.getJson(`${this.base}/ratios-ttm?symbol=${symbol}&apikey=${this.apiKey}`)) as Array<{
        priceToEarningsRatioTTM?: number;
      }>;
      const pe = Number(rows?.[0]?.priceToEarningsRatioTTM);
      return Number.isFinite(pe) && pe > 0 ? pe : undefined;
    } catch {
      return undefined;
    }
  }

  private async fetchConsensus(symbol: string): Promise<{ sentiment: number; headlines: string[] } | undefined> {
    try {
      const rows = (await this.getJson(`${this.base}/grades-consensus?symbol=${symbol}&apikey=${this.apiKey}`)) as Array<{
        strongBuy?: number;
        buy?: number;
        hold?: number;
        sell?: number;
        strongSell?: number;
        consensus?: string;
      }>;
      const row = rows?.[0];
      if (!row) return undefined;
      const strongBuy = num(row.strongBuy);
      const buy = num(row.buy);
      const hold = num(row.hold);
      const sell = num(row.sell);
      const strongSell = num(row.strongSell);
      const total = strongBuy + buy + hold + sell + strongSell;
      if (total === 0) return undefined;
      // Weighted analyst tone mapped to 0–100 (50 = neutral / all-hold).
      const sentiment = Math.round(((strongBuy * 100 + buy * 75 + hold * 50 + sell * 25 + strongSell * 0) / total));
      const headline = `Analyst consensus: ${row.consensus ?? "n/a"} (${strongBuy + buy} buy / ${hold} hold / ${sell + strongSell} sell)`;
      return { sentiment, headlines: [headline] };
    } catch {
      return undefined;
    }
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
