import { politeFetchText } from "./web-sources/http";

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

const BASE_URL = "https://financialmodelingprep.com/api";

function getApiKey(): string {
  const key = process.env.FMP_API_KEY;
  if (!key) {
    throw new Error("FMP_API_KEY is not set in the environment.");
  }
  return key;
}

function sanitizeFmpUrl(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete("apikey");
    return u.toString();
  } catch {
    return url.replace(/apikey=[^&]+/g, "apikey=***");
  }
}

async function fetchFmpJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    console.error(`FMP Error fetching ${sanitizeFmpUrl(url)}: ${res.status} - ${text}`);
    // Return empty array as degraded fallback rather than throwing, since every
    // caller is an array-returning endpoint. This prevents callers from needing
    // to wrap each call in a try/catch for transient 403/5xx responses.
    return ([] as unknown) as T;
  }
  return res.json() as Promise<T>;
}

export async function getHouseDisclosures(symbol?: string, page = 0): Promise<CongressTrade[]> {
  const apiKey = getApiKey();
  let url = `${BASE_URL}/v4/house-disclosure?apikey=${apiKey}&page=${page}`;
  if (symbol) {
    url += `&symbol=${symbol}`;
  }
  return fetchFmpJson<CongressTrade[]>(url);
}

export async function getSenateDisclosures(symbol?: string, page = 0): Promise<CongressTrade[]> {
  const apiKey = getApiKey();
  let url = `${BASE_URL}/v4/senate-trading?apikey=${apiKey}&page=${page}`;
  if (symbol) {
    url += `&symbol=${symbol}`;
  }
  return fetchFmpJson<CongressTrade[]>(url);
}

export async function getEarningsCalendar(from?: string, to?: string): Promise<EarningCalendar[]> {
  const apiKey = getApiKey();
  let url = `${BASE_URL}/v3/earning_calendar?apikey=${apiKey}`;
  if (from && to) {
    url += `&from=${from}&to=${to}`;
  }
  return fetchFmpJson<EarningCalendar[]>(url);
}

export async function getEconomicCalendar(from?: string, to?: string): Promise<EconomicCalendar[]> {
  const apiKey = getApiKey();
  let url = `${BASE_URL}/v3/economic_calendar?apikey=${apiKey}`;
  if (from && to) {
    url += `&from=${from}&to=${to}`;
  }
  return fetchFmpJson<EconomicCalendar[]>(url);
}

export async function getEarningsCallTranscript(symbol: string, year?: number, quarter?: number): Promise<EarningCallTranscript[]> {
  const apiKey = getApiKey();
  let url = `${BASE_URL}/v3/earning_call_transcript/${symbol}?apikey=${apiKey}`;
  if (year !== undefined) url += `&year=${year}`;
  if (quarter !== undefined) url += `&quarter=${quarter}`;
  return fetchFmpJson<EarningCallTranscript[]>(url);
}

export async function getMarketNews(tickers?: string, limit = 50, page = 0): Promise<FmpMarketNews[]> {
  const apiKey = getApiKey();
  let url = `${BASE_URL}/v3/stock_news?apikey=${apiKey}&limit=${limit}&page=${page}`;
  if (tickers) {
    url += `&tickers=${tickers}`;
  }
  return fetchFmpJson<FmpMarketNews[]>(url);
}
