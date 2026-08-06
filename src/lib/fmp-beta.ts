import { requestFmp } from "./fmp-common";

export interface FmpMacroQuote {
  symbol: string;
  name: string;
  price: number;
  changePercentage: number;
  change: number;
  dayLow?: number;
  dayHigh?: number;
  yearHigh?: number;
  yearLow?: number;
}

export interface FmpEconomicIndicator {
  name: string;
  date: string;
  value: number;
}

export interface FmpTreasuryRate {
  date: string;
  month1: number;
  month2: number;
  month3: number;
  month6: number;
  year1: number;
  year2: number;
  year3: number;
  year5: number;
  year7: number;
  year10: number;
  year20: number;
  year30: number;
}

/**
 * Fetch a single quote by symbol.
 */
export async function getMacroQuote(symbol: string): Promise<FmpMacroQuote | null> {
  const data = await requestFmp<FmpMacroQuote[]>("/quote", { symbol });
  return data && data.length > 0 ? data[0] : null;
}

/**
 * Fetch Macro Context: BTC/ETH (crypto), SPY/QQQ (ETFs), VIX (Volatility)
 */
export async function getMacroContext() {
  const [btc, eth, spy, qqq, vix] = await Promise.all([
    getMacroQuote("BTCUSD"),
    getMacroQuote("ETHUSD"),
    getMacroQuote("SPY"),
    getMacroQuote("QQQ"),
    getMacroQuote("^VIX")
  ]);
  return { btc, eth, spy, qqq, vix };
}

/**
 * Fetch an economic indicator by name (e.g. GDP, CPI, unemploymentRate, federalFunds).
 */
export async function getEconomicIndicator(name: string): Promise<FmpEconomicIndicator[]> {
  const data = await requestFmp<FmpEconomicIndicator[]>("/economic-indicators", { name });
  return data || [];
}

/**
 * Fetch Treasury Rates.
 */
export async function getTreasuryRates(): Promise<FmpTreasuryRate[]> {
  const data = await requestFmp<FmpTreasuryRate[]>("/treasury-rates");
  return data || [];
}

/**
 * Fetch a complete macro picture.
 */
export async function getFullMacroPicture() {
  const [macroContext, treasuryRates, gdp, cpi, unemployment, fedFunds] = await Promise.all([
    getMacroContext(),
    getTreasuryRates(),
    getEconomicIndicator("GDP"),
    getEconomicIndicator("CPI"),
    getEconomicIndicator("unemploymentRate"),
    getEconomicIndicator("federalFunds")
  ]);
  return {
    macroContext,
    treasuryRates,
    gdp,
    cpi,
    unemployment,
    fedFunds
  };
}