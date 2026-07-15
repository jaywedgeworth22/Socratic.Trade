import { config } from "dotenv";
config({ path: ".env.local" });

import { getFmpQuote, getFmpQuotes, getEtfHoldings, getEtfSectorWeightings, getIndexData } from "../src/lib/fmp-alpha";
import { getMacroQuote, getMacroContext, getEconomicIndicator, getTreasuryRates, getFullMacroPicture } from "../src/lib/fmp-beta";
import { getHouseDisclosures, getSenateDisclosures, getEarningsCalendar, getEconomicCalendar, getEarningsCallTranscript, getMarketNews } from "../src/lib/fmp-gamma";
import { fetchDCF, fetchFinancialScores, fetchAnalystGrades } from "../src/lib/fmp-delta";

async function runTest(name: string, fn: () => Promise<any>) {
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
        console.log(`  Sample:`, JSON.stringify(res[0], null, 2).slice(0, 200));
      }
    } else if (res !== null && typeof res === "object") {
      console.log(`  Sample keys:`, Object.keys(res));
      console.log(`  Sample:`, JSON.stringify(res, null, 2).slice(0, 200));
    } else {
      console.log(`  Result value:`, res);
    }
  } catch (err) {
    console.error(`[ERROR] ${name} threw an exception:`, err);
  }
  console.log("-".repeat(60));
}

async function main() {
  console.log("Starting FMP Integration Verification Suite");
  console.log("=".repeat(60));

  // Alpha tests
  await runTest("getFmpQuote(AAPL)", () => getFmpQuote("AAPL"));
  await runTest("getFmpQuotes([AAPL, MSFT])", () => getFmpQuotes(["AAPL", "MSFT"]));
  await runTest("getEtfHoldings(SPY)", () => getEtfHoldings("SPY"));
  await runTest("getEtfSectorWeightings(SPY)", () => getEtfSectorWeightings("SPY"));
  await runTest("getIndexData(^GSPC)", () => getIndexData("^GSPC"));

  // Beta tests
  await runTest("getMacroQuote(BTCUSD)", () => getMacroQuote("BTCUSD"));
  await runTest("getMacroContext()", () => getMacroContext());
  await runTest("getEconomicIndicator(GDP)", () => getEconomicIndicator("GDP"));
  await runTest("getTreasuryRates()", () => getTreasuryRates());
  await runTest("getFullMacroPicture()", () => getFullMacroPicture());

  // Gamma tests
  await runTest("getHouseDisclosures(AAPL)", () => getHouseDisclosures("AAPL"));
  await runTest("getSenateDisclosures(AAPL)", () => getSenateDisclosures("AAPL"));
  await runTest("getEarningsCalendar()", () => getEarningsCalendar());
  await runTest("getEconomicCalendar()", () => getEconomicCalendar());
  await runTest("getEarningsCallTranscript(AAPL)", () => getEarningsCallTranscript("AAPL"));
  await runTest("getMarketNews(AAPL)", () => getMarketNews("AAPL"));

  // Delta tests
  await runTest("fetchDCF(AAPL)", () => fetchDCF("AAPL"));
  await runTest("fetchFinancialScores(AAPL)", () => fetchFinancialScores("AAPL"));
  await runTest("fetchAnalystGrades(AAPL)", () => fetchAnalystGrades("AAPL"));
}

main().catch(console.error);
