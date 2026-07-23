import { requestFmp } from "./fmp-common";

/**
 * Fetch real-time quote for a symbol.
 */
export async function getFmpQuote(symbol: string) {
  const data = await requestFmp<any[]>("/quote", { symbol });
  return data && data.length > 0 ? data[0] : null;
}

/**
 * Fetch real-time quotes for multiple symbols.
 */
export async function getFmpQuotes(symbols: string[]) {
  if (symbols.length === 0) return [];
  const symbolString = symbols.join(",");
  const data = await requestFmp<any[]>("/quote", { symbol: symbolString });
  return data || [];
}

/**
 * Fetch ETF Holdings.
 */
export async function getEtfHoldings(symbol: string) {
  const data = await requestFmp<any[]>("/etf/holdings", { symbol });
  return data || [];
}

/**
 * Fetch ETF Sector Weightings.
 */
export async function getEtfSectorWeightings(symbol: string) {
  const data = await requestFmp<any[]>("/etf/sector-weightings", { symbol });
  return data || [];
}

/**
 * Fetch Index Market Data.
 * For S&P 500: ^GSPC
 * For Nasdaq: ^IXIC
 * For Dow Jones: ^DJI
 */
export async function getIndexData(symbol: string) {
  const data = await requestFmp<any[]>("/quote", { symbol });
  return data && data.length > 0 ? data[0] : null;
}
