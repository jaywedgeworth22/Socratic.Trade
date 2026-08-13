export interface YahooFinanceQuote {
  /** Exchange-reported issuer identity from chart metadata (longName/shortName). */
  companyName?: string;
  price: number;
  bid: number;
  ask: number;
  prevClose: number;
  volume: number;
  /** ISO timestamp of the quote (from meta.regularMarketTime) — the real "as of", not a daily-bar date. */
  asOf?: string;
  /** true when bid/ask were SYNTHESIZED from price (the chart endpoint has no real quote spread) rather
   *  than reported by Yahoo. Consumers must not treat a synthetic ask as a real quoted ask (e.g. for
   *  ask-relative limit pricing) — it is only a rough placeholder derived from the last price.
   *  `syntheticSpread` stays true only when BOTH sides were derived (for back-compat); the side-specific
   *  flags below tell you exactly which side is synthetic, so the REAL side of a one-sided quote is
   *  preserved rather than being blanket-tagged synthetic. */
  syntheticSpread?: boolean;
  /** true when the BID was derived from price (Yahoo reported no real bid). */
  syntheticBid?: boolean;
  /** true when the ASK was derived from price (Yahoo reported no real ask). */
  syntheticAsk?: boolean;
  /**
   * Optional keyless fundamentals.  Present when the chart meta or the v7 quote
   * endpoint actually returned them — never fabricated.  `dividendYield` is
   * percentage points (0.32 = 0.32%), matching YahooFinanceEnrichmentProvider.
   */
  peRatio?: number;
  eps?: number;
  dividendYield?: number;
  beta?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
}

function optionalFinite(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function optionalPositive(value: unknown): number | undefined {
  const n = optionalFinite(value);
  return n !== undefined && n > 0 ? n : undefined;
}

/** Yahoo `trailingAnnualDividendYield` is a fraction (0.0032 = 0.32%). */
export function yahooDividendYieldPercent(raw: unknown): number | undefined {
  const n = optionalFinite(raw);
  if (n === undefined || n < 0) return undefined;
  return Math.round(n * 10000) / 100;
}

export function yahooFundamentalsFromRecord(row: Record<string, unknown>): Pick<
  YahooFinanceQuote,
  "peRatio" | "eps" | "dividendYield" | "beta" | "fiftyTwoWeekHigh" | "fiftyTwoWeekLow"
> {
  const peRatio = optionalPositive(row.trailingPE ?? row.peRatio);
  const eps = optionalFinite(row.epsTrailingTwelveMonths ?? row.eps);
  const dividendYield = yahooDividendYieldPercent(
    row.trailingAnnualDividendYield ?? row.dividendYieldFraction
  );
  const beta = optionalFinite(row.beta);
  const fiftyTwoWeekHigh = optionalPositive(row.fiftyTwoWeekHigh);
  const fiftyTwoWeekLow = optionalPositive(row.fiftyTwoWeekLow);
  return {
    ...(peRatio !== undefined ? { peRatio } : {}),
    ...(eps !== undefined ? { eps } : {}),
    ...(dividendYield !== undefined ? { dividendYield } : {}),
    ...(beta !== undefined ? { beta } : {}),
    ...(fiftyTwoWeekHigh !== undefined ? { fiftyTwoWeekHigh } : {}),
    ...(fiftyTwoWeekLow !== undefined ? { fiftyTwoWeekLow } : {})
  };
}

export function mapYahooV7QuoteItem(
  item: Record<string, unknown> & {
    symbol?: string;
    regularMarketPrice?: number;
    bid?: number;
    ask?: number;
    regularMarketPreviousClose?: number;
    regularMarketVolume?: number;
    regularMarketTime?: number;
    longName?: string;
    shortName?: string;
  }
): YahooFinanceQuote | undefined {
  const price = Number(item.regularMarketPrice);
  if (!Number.isFinite(price) || price <= 0) return undefined;
  const prevClose = item.regularMarketPreviousClose ? Number(item.regularMarketPreviousClose) : price;
  const syntheticBid = !(item.bid && item.bid > 0);
  const syntheticAsk = !(item.ask && item.ask > 0);
  const hasRealSpread = !syntheticBid && !syntheticAsk;
  const bid = syntheticBid ? price * 0.999 : Number(item.bid);
  const ask = syntheticAsk ? price * 1.001 : Number(item.ask);
  const volume = Number(item.regularMarketVolume ?? 0);
  const t = Number(item.regularMarketTime);
  const asOf = Number.isFinite(t) && t > 0 ? new Date(t * 1000).toISOString() : undefined;
  const companyName = [item.longName, item.shortName]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0)
    ?.trim();
  return {
    ...(companyName ? { companyName } : {}),
    price,
    bid,
    ask,
    prevClose,
    volume,
    asOf,
    syntheticBid,
    syntheticAsk,
    ...(hasRealSpread ? {} : { syntheticSpread: true }),
    ...yahooFundamentalsFromRecord(item)
  };
}

/** Keyless v7 quote for one symbol — PE/EPS/div/beta/52w without the crumb handshake. */
export async function fetchYahooFinanceQuoteDetails(
  symbol: string
): Promise<YahooFinanceQuote | undefined> {
  const mapped = await fetchYahooFinanceQuotesBatch([symbol]);
  return mapped.get(symbol.toUpperCase().trim());
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
    const companyName = [meta.longName, meta.shortName]
      .find((value): value is string => typeof value === "string" && value.trim().length > 0)
      ?.trim();
    const prevClose = meta.chartPreviousClose ? Number(meta.chartPreviousClose) : price;
    const quote = payload?.chart?.result?.[0]?.indicators?.quote?.[0];
    const volume = Number(meta.regularMarketVolume ?? quote?.volume?.[0] ?? 0);
    // regularMarketTime is Unix seconds; convert to ISO for a real "as of" timestamp.
    const t = Number(meta.regularMarketTime);
    const asOf = Number.isFinite(t) && t > 0 ? new Date(t * 1000).toISOString() : undefined;
    // Chart meta often includes the 52-week range on the same payload as price/volume.
    // PE/EPS/div/beta live on the v7 quote endpoint (see fetchYahooFinanceQuoteDetails).
    const fundamentals = yahooFundamentalsFromRecord(meta);
    // The chart endpoint returns NO real bid/ask. We derive a rough spread from price ONLY so
    // downstream code has a placeholder, and mark it synthetic so it is never mistaken for a real
    // quoted ask (which would wrongly anchor ask-relative limit-price math).
    return {
      ...(companyName ? { companyName } : {}),
      price,
      bid: price * 0.999,
      ask: price * 1.001,
      prevClose,
      volume,
      asOf,
      // Fully synthetic single-quote fallback: both sides derived from price.
      syntheticBid: true,
      syntheticAsk: true,
      syntheticSpread: true,
      ...fundamentals
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
          result?: Array<Record<string, unknown> & {
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
        const mapped = mapYahooV7QuoteItem(item);
        if (mapped) result.set(item.symbol.toUpperCase().trim(), mapped);
      }
    } catch (err) {
      clearTimeout(timeout);
      console.error("[yahoo-finance] batch fetch failed for chunk:", chunk, err);
    }
  }

  return result;
}
