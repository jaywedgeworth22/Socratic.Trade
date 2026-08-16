// Demand-first symbol order for RAG ingest: names the desk is more likely to
// trade come first so a per-run cap fills held/watchlist/scan-adjacent names
// before the broad index tail.

import { listUsers, listWatchlistSymbols } from "../db-api-keys";
import { listRecentlyHeldSymbolsAllUsers, listRecentlyHeldSymbolValuesAllUsers } from "../db-fills";
import { getPolicy } from "../db-profiles";
import { symbolsForPolicyUniverse } from "../index-universes";
import { normalizeSymbol } from "../money";
import { getTechnicalWatchlist } from "../web-sources/technical";
import fs from "fs";
import path from "path";

function loadManifestRank(manifestPath: string = path.resolve("data/rag-universe-manifest.json")): Map<string, number> {
  const rank = new Map<string, number>();
  try {
    const raw = fs.readFileSync(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as { issuers?: Array<{ ticker?: unknown; rank?: unknown }> };
    for (const issuer of parsed.issuers ?? []) {
      const ticker = typeof issuer.ticker === "string" ? normalizeSymbol(issuer.ticker) : "";
      const r = typeof issuer.rank === "number" ? issuer.rank : undefined;
      if (ticker && r !== undefined && !rank.has(ticker)) rank.set(ticker, r);
    }
  } catch {
    // Non-fatal tail-fill.
  }
  return rank;
}

/**
 * Holdings by value, then watchlists, technical watchlist, each user's policy
 * index universe, then the 1k-issuer RAG manifest.  A symbol appears once at
 * its best tier so the cursor fills what the desk actually trades first.
 */
export function rankDemandFirstSymbols(options?: { symbols?: string[]; now?: number }): string[] {
  if (options?.symbols?.length) {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of options.symbols) {
      const s = normalizeSymbol(raw);
      if (!s || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
    return out;
  }

  const now = options?.now ?? Date.now();
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: string) => {
    const s = normalizeSymbol(raw);
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };

  try {
    const held = [...listRecentlyHeldSymbolValuesAllUsers(30, now).entries()]
      .filter(([, value]) => value > 0)
      .sort((a, b) => b[1] - a[1]);
    for (const [symbol] of held) push(symbol);
  } catch {
    for (const s of listRecentlyHeldSymbolsAllUsers(30, now)) push(s);
  }

  for (const userId of listUsers()) {
    try {
      for (const item of listWatchlistSymbols(userId)) push(item.symbol);
    } catch {
      // ignore per-user watchlist errors
    }
  }

  try {
    for (const s of getTechnicalWatchlist()) push(s);
  } catch {
    // ignore
  }

  for (const userId of listUsers()) {
    try {
      for (const s of symbolsForPolicyUniverse(getPolicy(userId))) push(s);
    } catch {
      // ignore per-user policy errors
    }
  }

  const manifest = [...loadManifestRank().entries()].sort((a, b) => a[1] - b[1]);
  for (const [symbol] of manifest) push(symbol);

  return out;
}
