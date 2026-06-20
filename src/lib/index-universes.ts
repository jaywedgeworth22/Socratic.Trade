import { normalizeSymbol } from "./money";
import { SP500_SYMBOLS } from "./sp500";
import type { IndexUniverse, TradingPolicy } from "./types";

export const NASDAQ100_SYMBOLS = [
  "NVDA",
  "AAPL",
  "MSFT",
  "AMZN",
  "GOOGL",
  "GOOG",
  "AVGO",
  "TSLA",
  "META",
  "MU",
  "WMT",
  "AMD",
  "ASML",
  "INTC",
  "AMAT",
  "LRCX",
  "CSCO",
  "ARM",
  "COST",
  "KLAC",
  "NFLX",
  "SNDK",
  "PLTR",
  "TXN",
  "MRVL",
  "WDC",
  "STX",
  "QCOM",
  "LIN",
  "PANW",
  "ADI",
  "TMUS",
  "PEP",
  "AMGN",
  "CRWD",
  "APP",
  "GILD",
  "HON",
  "ISRG",
  "SHOP",
  "BKNG",
  "SBUX",
  "VRTX",
  "PDD",
  "CDNS",
  "FTNT",
  "MAR",
  "CEG",
  "MNST",
  "ADP",
  "SNPS",
  "CSX",
  "ABNB",
  "MELI",
  "CMCSA",
  "DDOG",
  "NXPI",
  "ADBE",
  "MDLZ",
  "MPWR",
  "DASH",
  "ROST",
  "INTU",
  "ORLY",
  "AEP",
  "CTAS",
  "LITE",
  "WBD",
  "REGN",
  "PCAR",
  "BKR",
  "MCHP",
  "FAST",
  "FANG",
  "EA",
  "FER",
  "XEL",
  "EXC",
  "ODFL",
  "TTWO",
  "IDXX",
  "CCEP",
  "KDP",
  "ADSK",
  "MSTR",
  "PYPL",
  "ALNY",
  "PAYX",
  "TRI",
  "AXON",
  "ROP",
  "WDAY",
  "GEHC",
  "CPRT",
  "DXCM",
  "KHC",
  "VRSK",
  "INSM",
  "CTSH",
  "ZS",
  "CHTR"
] as const;

export const DOW30_SYMBOLS = [
  "GS",
  "CAT",
  "UNH",
  "MSFT",
  "AXP",
  "AMGN",
  "HD",
  "V",
  "JPM",
  "SHW",
  "TRV",
  "AAPL",
  "MCD",
  "IBM",
  "AMZN",
  "HON",
  "JNJ",
  "BA",
  "NVDA",
  "CVX",
  "MMM",
  "CRM",
  "PG",
  "CSCO",
  "WMT",
  "MRK",
  "DIS",
  "KO",
  "VZ",
  "NKE"
] as const;

export const INDEX_UNIVERSES = {
  sp500: { label: "S&P 500", symbols: SP500_SYMBOLS },
  nasdaq100: { label: "Nasdaq 100", symbols: NASDAQ100_SYMBOLS },
  dow30: { label: "Dow 30", symbols: DOW30_SYMBOLS }
} satisfies Record<IndexUniverse, { label: string; symbols: readonly string[] }>;

export const SUPPORTED_INDEX_UNIVERSES = Object.keys(INDEX_UNIVERSES) as IndexUniverse[];

export function isIndexUniverse(value: string): value is IndexUniverse {
  return value in INDEX_UNIVERSES;
}

export function indexUniverseLabel(index: IndexUniverse): string {
  return INDEX_UNIVERSES[index].label;
}

export function symbolsForPolicyUniverse(policy: Pick<TradingPolicy, "includedIndices" | "additionalSymbols" | "blocklist">): string[] {
  const symbols = new Set<string>();
  for (const index of policy.includedIndices || []) {
    INDEX_UNIVERSES[index]?.symbols.forEach((symbol) => symbols.add(symbol));
  }
  for (const symbol of policy.additionalSymbols || []) {
    const normalized = normalizeSymbol(symbol);
    if (normalized) symbols.add(normalized);
  }
  for (const symbol of policy.blocklist || []) {
    symbols.delete(normalizeSymbol(symbol));
  }
  return Array.from(symbols);
}
