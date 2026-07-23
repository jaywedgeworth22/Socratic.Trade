import { requestFmp } from "./fmp-common";

export interface CongressTrade {
  disclosureYear?: number;
  disclosureDate?: string;
  transactionDate: string;
  owner?: string;
  ticker: string;
  assetDescription?: string;
  type: string;
  amount: string;
  representative: string;
  district?: string;
  state?: string;
  link?: string;
}

export interface EarningCalendar {
  date: string;
  symbol: string;
  eps: number | null;
  epsEstimated: number | null;
  time: string;
  revenue: number | null;
  revenueEstimated: number | null;
  updatedFromDate: string;
  fiscalDateEnding: string;
}

export interface EconomicCalendar {
  date: string;
  country: string;
  event: string;
  currency: string;
  previous: number | null;
  estimate: number | null;
  actual: number | null;
  change: number | null;
  impact: string;
}

export interface EarningCallTranscript {
  symbol: string;
  quarter: number;
  year: number;
  date: string;
  content: string;
}

export interface FmpMarketNews {
  symbol: string;
  publishedDate: string;
  title: string;
  image: string;
  site: string;
  text: string;
  url: string;
}

export async function getHouseDisclosures(symbol?: string, page = 0): Promise<CongressTrade[]> {
  const endpoint = symbol ? "/house-trades" : "/house-latest";
  const params: Record<string, string | number> = { page };
  if (symbol) {
    params.symbol = symbol;
  }
  const data = await requestFmp<CongressTrade[]>(endpoint, params);
  return data || [];
}

export async function getSenateDisclosures(symbol?: string, page = 0): Promise<CongressTrade[]> {
  const endpoint = symbol ? "/senate-trades" : "/senate-latest";
  const params: Record<string, string | number> = { page };
  if (symbol) {
    params.symbol = symbol;
  }
  const data = await requestFmp<CongressTrade[]>(endpoint, params);
  return data || [];
}

export async function getEarningsCalendar(from?: string, to?: string): Promise<EarningCalendar[]> {
  const params: Record<string, string> = {};
  if (from) params.from = from;
  if (to) params.to = to;
  const data = await requestFmp<EarningCalendar[]>("/earnings-calendar", params);
  return data || [];
}

export async function getEconomicCalendar(from?: string, to?: string): Promise<EconomicCalendar[]> {
  const params: Record<string, string> = {};
  if (from) params.from = from;
  if (to) params.to = to;
  const data = await requestFmp<EconomicCalendar[]>("/economic-calendar", params);
  return data || [];
}

export async function getEarningsCallTranscript(symbol: string, year?: number, quarter?: number): Promise<EarningCallTranscript[]> {
  const params: Record<string, string | number> = { symbol };
  if (year !== undefined) params.year = year;
  if (quarter !== undefined) params.quarter = quarter;
  const data = await requestFmp<EarningCallTranscript[]>("/earning-call-transcript", params);
  return data || [];
}

export async function getMarketNews(tickers?: string, limit = 50, page = 0): Promise<FmpMarketNews[]> {
  const endpoint = tickers ? "/news/stock" : "/news/stock-latest";
  const params: Record<string, string | number> = { limit, page };
  if (tickers) {
    params.symbols = tickers;
  }
  const data = await requestFmp<FmpMarketNews[]>(endpoint, params);
  return data || [];
}
