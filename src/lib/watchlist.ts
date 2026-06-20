import { audit, addWatchlistSymbol, listWatchlistSymbols, removeWatchlistSymbol } from "./db";
import { normalizeSymbol } from "./money";
import type { WatchlistItem } from "./types";

const SYMBOL_RE = /^[A-Z.]{1,10}$/;

function validateSymbol(symbol: string): string {
  const normalized = normalizeSymbol(symbol);
  if (!SYMBOL_RE.test(normalized)) throw new Error(`invalid symbol: ${symbol}`);
  return normalized;
}

export function addToWatchlist(userId: string, symbol: string): WatchlistItem & { deduped: boolean } {
  const normalized = validateSymbol(symbol);
  const existing = listWatchlistSymbols(userId).find((item) => item.symbol === normalized);
  if (existing) return { ...existing, deduped: true };
  const item = addWatchlistSymbol(userId, normalized);
  audit("watchlist.add", { userId, symbol: normalized });
  return { ...item, deduped: false };
}

export function removeFromWatchlist(userId: string, symbol: string): boolean {
  const normalized = validateSymbol(symbol);
  const removed = removeWatchlistSymbol(userId, normalized);
  if (removed) audit("watchlist.remove", { userId, symbol: normalized });
  return removed;
}

export function listWatchlist(userId: string): WatchlistItem[] {
  return listWatchlistSymbols(userId);
}
