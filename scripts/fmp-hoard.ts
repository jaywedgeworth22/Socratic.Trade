import fs from "fs";
import path from "path";
import { FmpEnrichmentProvider } from "../src/lib/data-providers";
import { SP500_SYMBOLS } from "../src/lib/sp500";
import { NASDAQ100_SYMBOLS, DOW30_SYMBOLS } from "../src/lib/index-universes";
import { fetchBlackRockHoldingSymbols } from "../src/lib/fund-holdings";
import { normalizeSymbol } from "../src/lib/money";

function getGlobalFmpKey(): string {
  try {
    const secretsPath = "/Users/jay/.secrets/global-api-keys.env";
    const content = fs.readFileSync(secretsPath, "utf-8");
    const match = content.match(/FMP_API_KEY=("?[^"\n\r]+)/);
    if (match && match[1]) return match[1].replace(/"/g, '');
  } catch (err) {
    console.error("Failed to read global secrets", err);
  }
  if (process.env.FMP_API_KEY) return process.env.FMP_API_KEY;
  throw new Error("FMP_API_KEY not found in global secrets or env");
}

async function hoardEconomicCalendar(apiKey: string): Promise<void> {
  console.log("Hoarding FMP Economic Calendar...");
  const url = `https://financialmodelingprep.com/stable/economic-calendar?apikey=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`Failed to fetch economic calendar: HTTP ${res.status}`);
    return;
  }
  const data = await res.json();
  const file = path.join(process.cwd(), "data", "fmp-economic-calendar.json");
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`Saved ${Array.isArray(data) ? data.length : 0} economic calendar events to ${file}`);
}

async function hoardEarningsCalendar(apiKey: string): Promise<void> {
  console.log("Hoarding FMP Earnings Calendar...");
  const url = `https://financialmodelingprep.com/stable/earnings-calendar?apikey=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`Failed to fetch earnings calendar: HTTP ${res.status}`);
    return;
  }
  const data = await res.json();
  const file = path.join(process.cwd(), "data", "fmp-earnings-calendar.json");
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`Saved ${Array.isArray(data) ? data.length : 0} earnings calendar events to ${file}`);
}

const MAJOR_ETFS_AND_REITS = [
  // ETFs: Broad market, sectors, fixed income, commodities
  "SPY", "IVV", "VOO", "QQQ", "IWM", "OEF", "VTI", "SCHD",
  "XLK", "XLF", "XLE", "XLV", "XLY", "XLP", "XLI", "XLC", "XLU", "XLB", "XLRE",
  "VNQ", "JEPI", "JEPQ", "TLT", "GLD", "SLV", "USO", "UNG", "SOXX", "SMH", "ARKK",
  // Real Estate Investment Trusts (REITs)
  "O", "PLD", "AMT", "EQIX", "SPG", "PSA", "CCI", "DLR", "WELL", "VICI",
  "AVB", "EQR", "WY", "SBAC", "EXR", "MAA", "CPT", "INVH", "ARE"
];

async function hoard() {
  const apiKey = getGlobalFmpKey();
  
  // 1. Hoard Macro & Earnings Calendars
  await hoardEconomicCalendar(apiKey);
  await hoardEarningsCalendar(apiKey);

  // 2. Build Master Symbol List across all index universes (S&P 500, Nasdaq 100, Dow 30, Russell 2000, S&P 100, ETFs, REITs)
  console.log("Building master symbol list across all index universes...");
  const symbolSet = new Set<string>();

  // Add static index universes
  for (const sym of SP500_SYMBOLS) symbolSet.add(normalizeSymbol(sym));
  for (const sym of NASDAQ100_SYMBOLS) symbolSet.add(normalizeSymbol(sym));
  for (const sym of DOW30_SYMBOLS) symbolSet.add(normalizeSymbol(sym));
  for (const sym of MAJOR_ETFS_AND_REITS) symbolSet.add(normalizeSymbol(sym));

  // Add dynamic index universes (Russell 2000, S&P 100) via BlackRock holdings
  try {
    const r2k = await fetchBlackRockHoldingSymbols("russell2000", 3600000);
    for (const sym of r2k.symbols) symbolSet.add(normalizeSymbol(sym));
    console.log(`Added ${r2k.symbols.length} Russell 2000 symbols.`);
  } catch (err) {
    console.warn("Failed to fetch Russell 2000 holdings:", err);
  }

  try {
    const sp100 = await fetchBlackRockHoldingSymbols("sp100", 3600000);
    for (const sym of sp100.symbols) symbolSet.add(normalizeSymbol(sym));
    console.log(`Added ${sp100.symbols.length} S&P 100 symbols.`);
  } catch (err) {
    console.warn("Failed to fetch S&P 100 holdings:", err);
  }

  const allSymbols = Array.from(symbolSet).filter(Boolean);
  console.log(`Master Multi-Index Universe contains ${allSymbols.length} unique symbols (S&P 500, Nasdaq 100, Dow 30, Russell 2000, ETFs, REITs).`);

  // 3. Bulk Fundamentals Fetch across the entire multi-index universe
  const provider = new FmpEnrichmentProvider(apiKey, "env", "local");
  const chunkSize = 25;
  const totalChunks = Math.ceil(allSymbols.length / chunkSize);

  for (let i = 0; i < allSymbols.length; i += chunkSize) {
    const chunk = allSymbols.slice(i, i + chunkSize);
    console.log(`[FMP Hoard] Enriching chunk ${Math.floor(i / chunkSize) + 1}/${totalChunks} (${chunk.length} symbols)...`);
    await provider.enrich(chunk);
    await new Promise(r => setTimeout(r, 400));
  }
  console.log(`FMP multi-index fundamentals hoarding complete across all ${allSymbols.length} symbols!`);
}

hoard().catch(console.error);
