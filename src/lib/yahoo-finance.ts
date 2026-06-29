export interface YahooFinanceQuote {
  price: number;
  bid: number;
  ask: number;
  prevClose: number;
  volume: number;
  /** ISO timestamp of the quote (from meta.regularMarketTime) — the real "as of", not a daily-bar date. */
  asOf?: string;
}

export async function fetchYahooFinanceQuote(symbol: string): Promise<YahooFinanceQuote | undefined> {
  const clean = encodeURIComponent(symbol.toUpperCase());
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${clean}?interval=1d&range=1d`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) return undefined;
    const payload = await response.json() as { chart?: { result?: Array<{ meta?: Record<string, unknown>, indicators?: { quote?: Array<{ volume?: unknown[] }> } }> } };
    const meta = payload?.chart?.result?.[0]?.meta;
    if (!meta) return undefined;
    const price = Number(meta.regularMarketPrice);
    if (!Number.isFinite(price) || price <= 0) return undefined;
    const prevClose = meta.chartPreviousClose ? Number(meta.chartPreviousClose) : price;
    const quote = payload?.chart?.result?.[0]?.indicators?.quote?.[0];
    const volume = Number(meta.regularMarketVolume ?? quote?.volume?.[0] ?? 0);
    // regularMarketTime is Unix seconds; convert to ISO for a real "as of" timestamp.
    const t = Number(meta.regularMarketTime);
    const asOf = Number.isFinite(t) && t > 0 ? new Date(t * 1000).toISOString() : undefined;
    return {
      price,
      bid: price * 0.999,
      ask: price * 1.001,
      prevClose,
      volume,
      asOf
    };
  } catch {
    clearTimeout(timeout);
    return undefined;
  }
}
