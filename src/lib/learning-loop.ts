import { getDb } from "./db";
import type { StrategyOutcome } from "./types";
import { normalizeSymbol } from "./money";

export interface TradeExcursion {
  mae: number;
  mfe: number;
}

/**
 * Calculates Maximum Adverse Excursion (MAE) and Maximum Favorable Excursion (MFE)
 * for a given trade.
 */
export async function calculateExcursions(
  symbol: string,
  entryDate: Date,
  exitDate: Date,
  side: "buy" | "short",
  entryPrice: number
): Promise<TradeExcursion | null> {
  const normSymbol = normalizeSymbol(symbol);
  
  // Note: This relies on Yahoo Finance historical data. In production, a reliable 
  // OHLCV provider should be used.
  const startPeriod = Math.floor(entryDate.getTime() / 1000);
  const endPeriod = Math.floor(exitDate.getTime() / 1000);
  
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${normSymbol}?period1=${startPeriod}&period2=${endPeriod}&interval=1d`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    
    const result = json.chart?.result?.[0];
    if (!result || !result.indicators?.quote?.[0]) return null;
    
    const highs = result.indicators.quote[0].high as number[];
    const lows = result.indicators.quote[0].low as number[];
    
    if (!highs || !lows) return null;
    
    let highestHigh = entryPrice;
    let lowestLow = entryPrice;
    
    for (let i = 0; i < highs.length; i++) {
      if (highs[i] != null && highs[i] > highestHigh) highestHigh = highs[i];
      if (lows[i] != null && lows[i] < lowestLow) lowestLow = lows[i];
    }
    
    if (side === "buy") {
      return {
        mae: ((lowestLow - entryPrice) / entryPrice) * 100, // Negative percent usually, or absolute? Let's keep it signed
        mfe: ((highestHigh - entryPrice) / entryPrice) * 100
      };
    } else {
      // For short, high is adverse, low is favorable
      return {
        mae: ((entryPrice - highestHigh) / entryPrice) * 100, // Price goes up -> loss
        mfe: ((entryPrice - lowestLow) / entryPrice) * 100    // Price goes down -> profit
      };
    }
  } catch (err) {
    console.error("Failed to calculate excursion", err);
    return null;
  }
}

export async function runPostMortems() {
  // 1. Fetch closed lots that don't have MAE/MFE calculated.
  // 2. Fetch historical prices for their holding period.
  // 3. Update the database with MAE/MFE.
  // Currently, `performance.ts` calculates closed lots in-memory based on fills.
  // We'd need to trace those closed lots back to the DB to persist the learning loop metrics.
}
