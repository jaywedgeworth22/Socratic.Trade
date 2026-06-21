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

// ── logo.dev (cascade fallback) ───────────────────────────────────────────────
//
// logo.dev offers two lookup strategies:
//   1. By ticker  — img.logo.dev/ticker/AAPL?token=pk_xxx
//      Best for traded equities; covers most S&P 500 names automatically.
//   2. By domain  — img.logo.dev/apple.com?token=pk_xxx
//      Higher quality / broader coverage when the company domain is known.
//      Wire this once MarketQuote gains a `domain` field from enrichment.
//
// Set LOGO_DEV_TOKEN in .env.local to activate. The proxy route tries the
// GitHub source first, then falls back to logo.dev ticker if the token is set.
// Free tier: 500k req/month. Commercial use requires attribution.
// https://logo.dev

const LOGO_DEV_BASE = "https://img.logo.dev";

export function logoDevTickerUrl(symbol: string, token: string): string {
  return `${LOGO_DEV_BASE}/ticker/${encodeURIComponent(symbol)}?token=${encodeURIComponent(token)}&format=png`;
}

export function logoDevDomainUrl(domain: string, token: string): string {
  return `${LOGO_DEV_BASE}/${encodeURIComponent(domain)}?token=${encodeURIComponent(token)}&format=png`;
}
