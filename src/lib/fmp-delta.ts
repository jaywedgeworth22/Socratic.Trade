import { requestFmp } from "./fmp-common";

export interface DCFResult {
  symbol: string;
  date: string;
  dcf: number;
  stockPrice: number;
}

export interface FinancialScoreResult {
  symbol: string;
  altmanZScore: number;
  piotroskiScore: number;
  workingCapital: number;
  totalAssets: number;
  retainedEarnings: number;
  ebit: number;
  marketCap: number;
  totalLiabilities: number;
  revenue: number;
}

export interface AnalystGradeResult {
  symbol: string;
  date: string;
  gradingCompany: string;
  previousGrade: string;
  newGrade: string;
  action: string; // "maintain", "downgrade", "upgrade", etc.
}

export async function fetchDCF(symbol: string): Promise<DCFResult | null> {
  const data = await requestFmp<any[]>("/discounted-cash-flow", { symbol });
  if (!data || data.length === 0) return null;
  return {
    symbol: data[0].symbol,
    date: data[0].date,
    dcf: data[0].dcf,
    stockPrice: data[0]["Stock Price"]
  };
}

export async function fetchFinancialScores(symbol: string): Promise<FinancialScoreResult | null> {
  const data = await requestFmp<FinancialScoreResult[]>("/financial-scores", { symbol });
  if (!data || data.length === 0) return null;
  return data[0];
}

export async function fetchAnalystGrades(symbol: string): Promise<AnalystGradeResult[]> {
  const data = await requestFmp<AnalystGradeResult[]>("/grades", { symbol });
  if (!data || !Array.isArray(data)) return [];
  return data;
}
