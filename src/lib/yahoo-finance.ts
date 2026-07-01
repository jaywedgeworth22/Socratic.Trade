export interface YahooFinanceQuote {
  price: number;
  bid: number;
  ask: number;
  prevClose: number;
  volume: number;
  /** ISO timestamp of the quote (from meta.regularMarketTime) — the real "as of", not a daily-bar date. */
  asOf?: string;
  /** true when bid/ask were SYNTHESIZED from price (the chart endpoint has no real quote spread) rather
   *  than reported by Yahoo. Consumers must not treat a synthetic ask as a real quoted ask (e.g. for
   *  ask-relative limit pricing) — it is only a rough placeholder derived from the last price. */
  syntheticSpread?: boolean;
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
    // The chart endpoint returns NO real bid/ask. We derive a rough spread from price ONLY so
    // downstream code has a placeholder, and mark it synthetic so it is never mistaken for a real
    // quoted ask (which would wrongly anchor ask-relative limit-price math).
    return {
      price,
      bid: price * 0.999,
      ask: price * 1.001,
      prevClose,
      volume,
      asOf,
      syntheticSpread: true
    };
  } catch {
    clearTimeout(timeout);
    return undefined;
  }
}

export async function fetchYahooFinanceQuotesBatch(symbols: string[]): Promise<Map<string, YahooFinanceQuote>> {
  const result = new Map<string, YahooFinanceQuote>();
  if (symbols.length === 0) return result;

  // Chunk symbols into groups of 50
  const chunkSize = 50;
  for (let i = 0; i < symbols.length; i += chunkSize) {
    const chunk = symbols.slice(i, i + chunkSize);
    const cleanSymbols = chunk.map((s) => encodeURIComponent(s.toUpperCase().trim())).join(",");
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${cleanSymbols}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      const response = await fetch(url, { cache: "no-store", signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) continue;
      const payload = await response.json() as {
        quoteResponse?: {
          result?: Array<{
            symbol: string;
            regularMarketPrice?: number;
            bid?: number;
            ask?: number;
            regularMarketPreviousClose?: number;
            regularMarketVolume?: number;
            regularMarketTime?: number;
          }>;
        };
      };

      const items = payload?.quoteResponse?.result;
      if (!items) continue;

      for (const item of items) {
        if (!item.symbol) continue;
        const price = Number(item.regularMarketPrice);
        if (!Number.isFinite(price) || price <= 0) continue;
        const prevClose = item.regularMarketPreviousClose ? Number(item.regularMarketPreviousClose) : price;
        const hasRealSpread = Boolean(item.bid && item.bid > 0 && item.ask && item.ask > 0);
        const bid = item.bid && item.bid > 0 ? Number(item.bid) : price * 0.999;
        const ask = item.ask && item.ask > 0 ? Number(item.ask) : price * 1.001;
        const volume = Number(item.regularMarketVolume ?? 0);
        const t = Number(item.regularMarketTime);
        const asOf = Number.isFinite(t) && t > 0 ? new Date(t * 1000).toISOString() : undefined;

        result.set(item.symbol.toUpperCase().trim(), {
          price,
          bid,
          ask,
          prevClose,
          volume,
          asOf,
          // Only mark synthetic when we had to derive BOTH sides from price.
          ...(hasRealSpread ? {} : { syntheticSpread: true })
        });
      }
    } catch (err) {
      clearTimeout(timeout);
      console.error("[yahoo-finance] batch fetch failed for chunk:", chunk, err);
    }
  }

  return result;
}

