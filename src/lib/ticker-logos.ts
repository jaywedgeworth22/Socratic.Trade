export type TickerLogoDisplay = "tile" | "transparent" | "off";

export const DEFAULT_TICKER_LOGO_DISPLAY: TickerLogoDisplay = "tile";

const TICKER_LOGO_VALUES = new Set<TickerLogoDisplay>(["tile", "transparent", "off"]);
const TICKER_LOGO_BASE_URL = "https://raw.githubusercontent.com/davidepalazzo/ticker-logos/main/ticker_icons";
const SYMBOL_PATTERN = /^[A-Z0-9._-]{1,20}$/;

export function isTickerLogoDisplay(value: unknown): value is TickerLogoDisplay {
  return typeof value === "string" && TICKER_LOGO_VALUES.has(value as TickerLogoDisplay);
}

export function normalizeTickerLogoSymbol(value: string | null | undefined): string | null {
  const symbol = value?.trim().replace(/^\$/, "").toUpperCase();
  if (!symbol || !SYMBOL_PATTERN.test(symbol)) return null;
  return symbol;
}

export function tickerLogoCandidates(value: string | null | undefined): string[] {
  const symbol = normalizeTickerLogoSymbol(value);
  if (!symbol) return [];
  return Array.from(new Set([
    symbol,
    symbol.replace(/\./g, "-"),
    symbol.replace(/-/g, "."),
    symbol.replace(/[.-]/g, "_")
  ]));
}

export function tickerLogoRawUrl(symbol: string): string {
  return `${TICKER_LOGO_BASE_URL}/${encodeURIComponent(symbol)}.png`;
}
