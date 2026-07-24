import fs from "fs";
import path from "path";
import { FmpEnrichmentProvider } from "../src/lib/data-providers";
import { SP500_SYMBOLS } from "../src/lib/sp500";

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

async function hoard() {
  const apiKey = getGlobalFmpKey();
  
  // 1. Hoard Macro & Earnings Calendars
  await hoardEconomicCalendar(apiKey);
  await hoardEarningsCalendar(apiKey);

  // 2. Fetch Fundamentals & Enrichment for S&P 500 Universe
  const allSymbols = Array.from(new Set(SP500_SYMBOLS));
  console.log(`Beginning bulk fundamentals fetch for ${allSymbols.length} symbols...`);
  const provider = new FmpEnrichmentProvider(apiKey, "env", "local");
  
  // Chunk in batches of 20 to avoid memory or network rate limit issues
  const chunkSize = 20;
  for (let i = 0; i < allSymbols.length; i += chunkSize) {
    const chunk = allSymbols.slice(i, i + chunkSize);
    console.log(`Enriching chunk ${Math.floor(i / chunkSize) + 1}/${Math.ceil(allSymbols.length / chunkSize)} (${chunk.length} symbols)...`);
    await provider.enrich(chunk);
    await new Promise(r => setTimeout(r, 500));
  }
  console.log("FMP fundamentals hoarding complete!");
}

hoard().catch(console.error);
