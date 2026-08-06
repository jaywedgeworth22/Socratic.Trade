import fs from "fs";
import path from "path";

// Load .env.local manually to avoid dependency on @types/dotenv
try {
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        const idx = trimmed.indexOf("=");
        if (idx !== -1) {
          const key = trimmed.slice(0, idx).trim();
          const val = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
          process.env[key] = val;
        }
      }
    }
  }
} catch (e) {
  console.warn("Could not load .env.local manually:", e);
}

import { getFmpQuote, getFmpQuotes, getEtfHoldings, getEtfSectorWeightings, getIndexData } from "../src/lib/fmp-alpha";
import { getMacroQuote, getMacroContext, getEconomicIndicator, getTreasuryRates, getFullMacroPicture } from "../src/lib/fmp-beta";
import { getHouseDisclosures, getSenateDisclosures, getEarningsCalendar, getEconomicCalendar, getEarningsCallTranscript, getMarketNews } from "../src/lib/fmp-gamma";
import { fetchDCF, fetchFinancialScores, fetchAnalystGrades } from "../src/lib/fmp-delta";

function cleanSample(item: any): any {
  if (item && typeof item === "object") {
    const copy = { ...item };
    if ("content" in copy) {
      copy.content = "[REDACTED TRANSCRIPT CONTENT]";
    }
    return copy;
  }
  return item;
}

async function runTest(name: string, fn: () => Promise<any>): Promise<boolean> {
  console.log(`[TEST] Testing ${name}...`);
  try {
    const start = Date.now();
    const res = await fn();
    const elapsed = Date.now() - start;
    console.log(`[SUCCESS] ${name} (${elapsed}ms)`);
    console.log(`  Result type: ${Array.isArray(res) ? "Array" : typeof res}`);
    if (Array.isArray(res)) {
      console.log(`  Result length: ${res.length}`);
      if (res.length > 0) {
        console.log(`  Sample:`, JSON.stringify(cleanSample(res[0]), null, 2).slice(0, 200));
      }
    } else if (res !== null && typeof res === "object") {
      console.log(`  Sample keys:`, Object.keys(res));
      console.log(`  Sample:`, JSON.stringify(cleanSample(res), null, 2).slice(0, 200));
    } else {
      console.log(`  Result value:`, res);
    }
    console.log("-".repeat(60));
    return true;
  } catch (err) {
    console.error(`[ERROR] ${name} threw an exception:`, err);
    console.log("-".repeat(60));
    return false;
  }
}

async function main() {
  console.log("Starting FMP Integration Verification Suite");
  console.log("=".repeat(60));

  let success = true;

  // Alpha tests
  if (!await runTest("getFmpQuote(AAPL)", () => getFmpQuote("AAPL"))) success = false;
  if (!await runTest("getFmpQuotes([AAPL, MSFT])", () => getFmpQuotes(["AAPL", "MSFT"]))) success = false;
  if (!await runTest("getEtfHoldings(SPY)", () => getEtfHoldings("SPY"))) success = false;
  if (!await runTest("getEtfSectorWeightings(SPY)", () => getEtfSectorWeightings("SPY"))) success = false;
  if (!await runTest("getIndexData(^GSPC)", () => getIndexData("^GSPC"))) success = false;

  // Beta tests
  if (!await runTest("getMacroQuote(BTCUSD)", () => getMacroQuote("BTCUSD"))) success = false;
  if (!await runTest("getMacroContext()", () => getMacroContext())) success = false;
  if (!await runTest("getEconomicIndicator(GDP)", () => getEconomicIndicator("GDP"))) success = false;
  if (!await runTest("getTreasuryRates()", () => getTreasuryRates())) success = false;
  if (!await runTest("getFullMacroPicture()", () => getFullMacroPicture())) success = false;

  // Gamma tests
  if (!await runTest("getHouseDisclosures(AAPL)", () => getHouseDisclosures("AAPL"))) success = false;
  if (!await runTest("getSenateDisclosures(AAPL)", () => getSenateDisclosures("AAPL"))) success = false;
  if (!await runTest("getEarningsCalendar()", () => getEarningsCalendar())) success = false;
  if (!await runTest("getEconomicCalendar()", () => getEconomicCalendar())) success = false;
  if (!await runTest("getEarningsCallTranscript(AAPL)", () => getEarningsCallTranscript("AAPL"))) success = false;
  if (!await runTest("getMarketNews(AAPL)", () => getMarketNews("AAPL"))) success = false;

  // Delta tests
  if (!await runTest("fetchDCF(AAPL)", () => fetchDCF("AAPL"))) success = false;
  if (!await runTest("fetchFinancialScores(AAPL)", () => fetchFinancialScores("AAPL"))) success = false;
  if (!await runTest("fetchAnalystGrades(AAPL)", () => fetchAnalystGrades("AAPL"))) success = false;

  if (!success) {
    console.error("FMP Integration Verification Failed");
    process.exitCode = 1;
  } else {
    console.log("FMP Integration Verification Passed");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
