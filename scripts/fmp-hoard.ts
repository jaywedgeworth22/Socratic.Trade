import fs from "fs";
import path from "path";
import { FmpEnrichmentProvider } from "../src/lib/data-providers";
import { SP500_SYMBOLS } from "../src/lib/sp500";
import { fetchWithRetry } from "../src/lib/data-providers";

// Load FMP Key directly from global secrets for the standalone script
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

async function fetchConstituents(apiKey: string, endpoint: string): Promise<string[]> {
  console.log(`Fetching constituents from ${endpoint}...`);
  const url = `https://financialmodelingprep.com/api/v3/${endpoint}?apikey=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`Failed to fetch ${endpoint}: HTTP ${res.status}`);
    return [];
  }
  const data = await res.json();
  if (Array.isArray(data)) {
    return data.map((item: any) => item.symbol).filter(Boolean);
  }
  return [];
}

async function fetchHistoricalData(apiKey: string, symbol: string): Promise<void> {
  const dir = path.join(process.cwd(), "data", "fmp-history");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  
  const file = path.join(dir, `${symbol}.json`);
  if (fs.existsSync(file)) return; // skip if already downloaded
  
  const url = `https://financialmodelingprep.com/api/v3/historical-price-full/${symbol}?apikey=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`Failed historical data for ${symbol}: HTTP ${res.status}`);
    return;
  }
  const data = await res.json();
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

async function hoard() {
  const apiKey = getGlobalFmpKey();
  
  // 1. Build Master Symbol List
  const sp500 = await fetchConstituents(apiKey, "sp500_constituent");
  const nasdaq = await fetchConstituents(apiKey, "nasdaq_constituent");
  const dow = await fetchConstituents(apiKey, "dowjones_constituent");
  
  const allSymbols = new Set([...SP500_SYMBOLS, ...sp500, ...nasdaq, ...dow]);
  console.log(`Master list contains ${allSymbols.size} unique symbols.`);
  
  // 2. Fetch Fundamentals (this uses internal pacing!)
  console.log("Beginning bulk fundamentals fetch (this will take a while)...");
  const provider = new FmpEnrichmentProvider(apiKey, "env", "local");
  // enrich processes chunks safely, storing data into SQLite.
  await provider.enrich(Array.from(allSymbols));
  console.log("Fundamentals fetching complete!");
  
  // 3. Fetch Historicals for S&P 500
  console.log(`Fetching 5-year historical data for ${SP500_SYMBOLS.length} symbols...`);
  // Simple custom pacing (e.g., 5 requests per second)
  for (let i = 0; i < SP500_SYMBOLS.length; i++) {
    const symbol = SP500_SYMBOLS[i];
    if (i % 50 === 0) console.log(`Historical progress: ${i}/${SP500_SYMBOLS.length}`);
    await fetchHistoricalData(apiKey, symbol);
    await new Promise(r => setTimeout(r, 250)); // ~4/sec to stay within 300/min safely
  }
  console.log("Historical fetching complete!");
}

hoard().catch(console.error);
