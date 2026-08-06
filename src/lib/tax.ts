import { DEFAULT_TAX_SETTINGS } from "./defaults";
import { getPolicy, listConnectedAccounts, listFillEvents } from "./db";
import { normalizeSymbol } from "./money";
import { getClosedLotsDetailed, getOpenLots, type ClosedLot, type PrefetchedFills, type PrefetchedPnl } from "./performance";
import type { FillEvent, FillSource, TaxSettings, TaxationType } from "./types";

const MS_PER_DAY = 86_400_000;
const WASH_WINDOW_DAYS = 30;
const LONG_TERM_DAYS = 365;

export interface WashSaleFlag {
  symbol: string;
  soldAt: string;
  disallowedLoss: number; // positive dollars of loss disallowed
}

export interface OpenLotTax {
  symbol: string;
  quantity: number;
  entryAt?: string;
  daysHeld: number;
  daysToLongTerm: number;
  isLongTerm: boolean;
  unrealizedGain?: number; // dollars: (currentPrice - avgCost) * qty — positive = gain
  earlyExitTaxPremium?: number; // extra tax vs waiting for long-term: unrealizedGain * (shortRate - longRate) / 100
}

export interface HarvestCandidate {
  symbol: string;
  quantity: number;
  unrealizedLoss: number; // negative dollars
}

/** Rough US tax picture for a trading account. Estimates only — not tax advice. */
export interface TaxSummary {
  taxYear: number;
  shortTermRealized: number; // YTD realized P&L on lots held <= 1 year (wash-sale losses excluded)
  longTermRealized: number; // YTD realized P&L on lots held > 1 year
  totalRealized: number;
  disallowedWashSaleLoss: number;
  estimatedShortTermTax: number;
  estimatedLongTermTax: number;
  estimatedTaxLiability: number;
  washSales: WashSaleFlag[];
  lockedSymbols: string[];
  openLots: OpenLotTax[];
  harvestCandidates: HarvestCandidate[];
  settings: TaxSettings;
}

export function resolveTaxSettings(settings?: Partial<TaxSettings>): TaxSettings {
  const merged = { ...DEFAULT_TAX_SETTINGS, ...(settings ?? {}) };
  // Tax-sheltered IRAs: no annual capital-gains tax, and the IRC §1091 wash-sale lockout has no
  // benefit within the account — so zero the rates and disable the per-account guard. (A loss in a
  // TAXABLE account still locks rebuys across all accounts; that is enforced separately via
  // getWashSaleLockedSymbolsForUser, not this per-account flag.)
  if (merged.taxationType === "roth_ira" || merged.taxationType === "traditional_ira") {
    return { ...merged, washSaleGuard: false, shortTermRatePct: 0, longTermRatePct: 0 };
  }
  return merged;
}

function holdingDays(entryAt: string | undefined, exitAt: string | undefined): number {
  if (!entryAt || !exitAt) return 0;
  const ms = new Date(exitAt).getTime() - new Date(entryAt).getTime();
  return Number.isFinite(ms) ? Math.max(0, ms / MS_PER_DAY) : 0;
}

/**
 * PR #8 — per-symbol wash-sale provenance. When a symbol is locked, this records WHICH account's
 * loss is binding and WHEN the lockout clears, so the Approvals card can name the culprit
 * ("locked by a loss in Robinhood · clears Jul 24"). `clearDate` is when the symbol becomes
 * rebuyable = the latest contributing loss's exit + 30 days (the binding loss — a symbol stays
 * locked until every contributing loss ages out of the window).
 */
export interface WashSaleLock {
  account: string; // the BINDING contributing account's number/id (latest clear date)
  clearDate: Date; // date the symbol becomes rebuyable (binding loss exit + 30d)
  /**
   * Total positive dollars of still-in-window realized loss on the symbol, SUMMED across every
   * contributing lot and account (a rebuy now washes all of them under IRC §1091 — the rule
   * applies across the taxpayer's accounts). This is the disallowed-loss amount the "ask"/"auto"
   * wash-sale handling modes price: estimated tax cost = lossUsd × shortTermRatePct.
   * Losses below the per-account washSaleMinLossUsd floor contribute neither lock nor lossUsd.
   */
  lossUsd: number;
}
export type WashSaleLockMap = Map<string, WashSaleLock>;

// Keep the BINDING loss per symbol — the one with the latest clear date, since the symbol stays
// locked until the most recent contributing loss ages out of the 30-day window. lossUsd SUMS
// across contributions (see WashSaleLock.lossUsd) while account/clearDate track the binding loss.
function mergeWashSaleLock(map: WashSaleLockMap, symbol: string, lock: WashSaleLock): void {
  const existing = map.get(symbol);
  if (!existing) {
    map.set(symbol, lock);
    return;
  }
  const binding = lock.clearDate.getTime() > existing.clearDate.getTime() ? lock : existing;
  map.set(symbol, {
    account: binding.account,
    clearDate: binding.clearDate,
    lossUsd: Number((existing.lossUsd + lock.lossUsd).toFixed(2))
  });
}

/**
 * Per-account wash-sale lockout WITH provenance: for each symbol whose LONG position was closed at
 * a LOSS within the last 30 days (IRC §1091), record the account + the clear date. The Set-returning
 * helpers below project this so the authoritative enforcement gate keeps its exact `Set<string>`
 * shape (never a silent runtime reshape) while the Approvals UI reads provenance from the map.
 */
export function getWashSaleLockProvenance(
  accountNumber: string,
  source: FillSource,
  now = new Date(),
  userId: string = "local",
  prefetched?: PrefetchedFills,
  minLossUsd?: number,
  prefetchedPnl?: PrefetchedPnl
): WashSaleLockMap {
  const locked: WashSaleLockMap = new Map();
  const cutoff = now.getTime() - WASH_WINDOW_DAYS * MS_PER_DAY;
  // Optional materiality floor (taxSettings.washSaleMinLossUsd): losses smaller than this do
  // NOT contribute a lockout. Default undefined/<=0 = every loss locks (original behavior).
  const lossFloor = typeof minLossUsd === "number" && Number.isFinite(minLossUsd) && minLossUsd > 0 ? minLossUsd : 0;
  for (const lot of getClosedLotsDetailed(accountNumber, source, userId, prefetched, prefetchedPnl)) {
    if (lot.pnl >= 0 || lot.side !== "long" || !lot.exitAt || !lot.symbol) continue;
    if (lossFloor > 0 && Math.abs(lot.pnl) < lossFloor) continue;
    const exitT = new Date(lot.exitAt).getTime();
    if (Number.isFinite(exitT) && exitT >= cutoff && exitT <= now.getTime()) {
      const clearDate = new Date(exitT + WASH_WINDOW_DAYS * MS_PER_DAY);
      const lossUsd = Number(Math.abs(lot.pnl).toFixed(2));
      mergeWashSaleLock(locked, normalizeSymbol(lot.symbol), { account: accountNumber, clearDate, lossUsd });
    }
  }
  return locked;
}

/**
 * Symbols currently inside a 30-day wash-sale lockout: a LONG position in the symbol
 * was closed at a LOSS within the last 30 days, so rebuying now (within the 61-day
 * window) would create a wash sale and disallow that loss (IRC §1091). Used by the
 * policy guardrail to block new buys. Derived from the provenance map (one source of truth).
 */
export function getWashSaleLockedSymbols(
  accountNumber: string,
  source: FillSource,
  now = new Date(),
  userId: string = "local",
  prefetched?: PrefetchedFills,
  minLossUsd?: number,
  prefetchedPnl?: PrefetchedPnl
): Set<string> {
  return new Set(getWashSaleLockProvenance(accountNumber, source, now, userId, prefetched, minLossUsd, prefetchedPnl).keys());
}

export interface AccountTaxContext {
  accountNumber: string;
  source: FillSource;
  taxationType?: TaxationType;
  /** Per-account materiality floor for lockout contribution (taxSettings.washSaleMinLossUsd). */
  washSaleMinLossUsd?: number;
}

/**
 * Cross-account wash-sale lockout WITH provenance (IRC §1091 + Rev. Rul. 2008-5): a LOSS realized in
 * a TAXABLE account locks rebuys of that symbol across ALL of the user's accounts — including the
 * IRAs — for 30 days, because buying the replacement inside an IRA permanently destroys the
 * disallowed basis. Losses realized INSIDE an IRA create no lockout (a wash sale has no benefit
 * there). Returns the merged provenance map contributed by the user's taxable accounts.
 */
export function getWashSaleLockProvenanceForUser(accounts: AccountTaxContext[], now = new Date(), userId: string = "local"): WashSaleLockMap {
  const locked: WashSaleLockMap = new Map();
  for (const acct of accounts) {
    if (acct.taxationType === "roth_ira" || acct.taxationType === "traditional_ira") continue;
    if (!acct.accountNumber) continue;
    for (const [sym, lock] of getWashSaleLockProvenance(acct.accountNumber, acct.source, now, userId, undefined, acct.washSaleMinLossUsd)) {
      mergeWashSaleLock(locked, sym, lock);
    }
  }
  return locked;
}

/** Union of locked symbols across the user's taxable accounts (projection of the provenance map). */
export function getWashSaleLockedSymbolsForUser(accounts: AccountTaxContext[], now = new Date(), userId: string = "local"): Set<string> {
  return new Set(getWashSaleLockProvenanceForUser(accounts, now, userId).keys());
}

/**
 * Resolve the user's connected accounts and compute the cross-account lockout provenance.
 *
 * PR #8 — a Test/sim account is EXCLUDED from contribution: it trades fake money, so a simulated
 * loss must never lock a symbol in a real taxable account. (Previously Test was mapped to the
 * "paper" source and included, letting a simulated loss lock a real account.)
 */
export function getUserWashSaleLockProvenance(userId: string = "local", now = new Date()): WashSaleLockMap {
  const accounts: AccountTaxContext[] = listConnectedAccounts(userId)
    .filter((a) => a.broker !== "test")
    .map((a) => ({
      accountNumber: a.accountNumber ?? "",
      source: (a.environment === "paper" ? "paper" : "live") as FillSource,
      taxationType: a.taxationType,
      // Each account contributes its losses under ITS OWN policy's materiality floor
      // (taxSettings.washSaleMinLossUsd) — policies are account-scoped.
      washSaleMinLossUsd: safeAccountWashSaleMinLoss(userId, a.id)
    }));
  return getWashSaleLockProvenanceForUser(accounts, now, userId);
}

/** Best-effort per-account taxSettings.washSaleMinLossUsd lookup. A policy read failure must
 *  never break the lockout computation — degrade to undefined (= every loss locks). */
function safeAccountWashSaleMinLoss(userId: string, connectedAccountId: string): number | undefined {
  try {
    return getPolicy(userId, connectedAccountId).taxSettings?.washSaleMinLossUsd;
  } catch {
    return undefined;
  }
}

/** Convenience: the user's cross-account locked-symbol Set (projection; feeds the enforcement gate). */
export function getUserWashSaleLockedSymbols(userId: string = "local", now = new Date()): Set<string> {
  return new Set(getUserWashSaleLockProvenance(userId, now).keys());
}

/**
 * Wash sales already realized: a loss-closing LONG sale with a separate buy of the
 * same symbol within ±30 days (the replacement purchase) — that loss is disallowed.
 */
function detectWashSales(fills: FillEvent[], closedLots: ClosedLot[], taxYear: number): WashSaleFlag[] {
  const buysBySymbol = new Map<string, number[]>();
  for (const fill of fills) {
    if (fill.side !== "buy") continue;
    const t = new Date(fill.filledAt).getTime();
    if (!Number.isFinite(t)) continue;
    const sym = normalizeSymbol(fill.symbol);
    const list = buysBySymbol.get(sym);
    if (list) list.push(t);
    else buysBySymbol.set(sym, [t]);
  }

  const window = WASH_WINDOW_DAYS * MS_PER_DAY;
  const flags: WashSaleFlag[] = [];
  for (const lot of closedLots) {
    if (lot.pnl >= 0 || lot.side !== "long" || !lot.exitAt || !lot.symbol) continue;
    if (new Date(lot.exitAt).getFullYear() !== taxYear) continue;
    const sym = normalizeSymbol(lot.symbol);
    const exitT = new Date(lot.exitAt).getTime();
    const entryT = lot.entryAt ? new Date(lot.entryAt).getTime() : Number.NaN;
    const buys = buysBySymbol.get(sym) ?? [];
    // A replacement buy within ±30 days of the sale that isn't this lot's own opening buy.
    const hasReplacement = buys.some((t) => Math.abs(t - exitT) <= window && (!Number.isFinite(entryT) || Math.abs(t - entryT) > MS_PER_DAY));
    if (hasReplacement) flags.push({ symbol: sym, soldAt: lot.exitAt, disallowedLoss: Number(Math.abs(lot.pnl).toFixed(2)) });
  }
  return flags;
}

export function getTaxSummary(
  accountNumber: string,
  source: FillSource,
  currentPrices: Record<string, number> = {},
  settings?: Partial<TaxSettings>,
  now = new Date(),
  userId: string = "local",
  prefetched?: PrefetchedFills,
  prefetchedPnl?: PrefetchedPnl
): TaxSummary {
  const tax = resolveTaxSettings(settings);
  const taxYear = now.getFullYear();
  // Prefer the pre-fetched source-matching fills so a shared request replays them once; the direct
  // `detectWashSales` read here reuses the same array instead of a third SELECT for the same source.
  const prefetchedSourceFills = source === "live" ? prefetched?.liveFills : source === "paper" ? prefetched?.paperFills : undefined;
  const fills = prefetchedSourceFills ?? listFillEvents(accountNumber, source, 500, userId);
  const closedLots = getClosedLotsDetailed(accountNumber, source, userId, prefetched, prefetchedPnl);
  const openLotsRaw = getOpenLots(accountNumber, source, userId, prefetched, prefetchedPnl);

  const washSales = detectWashSales(fills, closedLots, taxYear);
  const disallowedKeys = new Set(washSales.map((w) => `${w.symbol}:${w.soldAt}`));

  let shortTermRealized = 0;
  let longTermRealized = 0;
  for (const lot of closedLots) {
    if (lot.side !== "long" || !lot.exitAt || new Date(lot.exitAt).getFullYear() !== taxYear) continue;
    const disallowed = lot.pnl < 0 && lot.symbol && disallowedKeys.has(`${normalizeSymbol(lot.symbol)}:${lot.exitAt}`);
    const effective = disallowed ? 0 : lot.pnl; // disallowed wash-sale losses aren't deductible this year
    if (holdingDays(lot.entryAt, lot.exitAt) > LONG_TERM_DAYS) longTermRealized += effective;
    else shortTermRealized += effective;
  }

  const estimatedShortTermTax = Math.max(0, shortTermRealized) * (tax.shortTermRatePct / 100);
  const estimatedLongTermTax = Math.max(0, longTermRealized) * (tax.longTermRatePct / 100);

  const openLots: OpenLotTax[] = openLotsRaw
    .filter((lot) => lot.side === "long")
    .map((lot) => {
      const days = lot.entryAt ? Math.max(0, (now.getTime() - new Date(lot.entryAt).getTime()) / MS_PER_DAY) : 0;
      const sym = normalizeSymbol(lot.symbol);
      const currentPrice = currentPrices[sym] ?? null;
      const unrealizedGain = currentPrice != null ? (currentPrice - lot.entryPrice) * lot.quantity : undefined;
      const earlyExitTaxPremium = unrealizedGain != null && unrealizedGain > 0
        ? unrealizedGain * ((tax.shortTermRatePct - tax.longTermRatePct) / 100)
        : undefined;
      return {
        symbol: sym,
        quantity: lot.quantity, // keep full share precision in the record; the UI formats for display
        entryAt: lot.entryAt,
        daysHeld: Math.floor(days),
        daysToLongTerm: Math.max(0, Math.ceil(LONG_TERM_DAYS - days)),
        isLongTerm: days > LONG_TERM_DAYS,
        unrealizedGain,
        earlyExitTaxPremium
      };
    })
    .sort((a, b) => a.daysToLongTerm - b.daysToLongTerm);

  const harvestMap = new Map<string, { quantity: number; loss: number }>();
  for (const lot of openLotsRaw) {
    if (lot.side !== "long") continue;
    const sym = normalizeSymbol(lot.symbol);
    const price = currentPrices[sym];
    if (!price || price <= 0) continue;
    const unrealized = lot.quantity * (price - lot.entryPrice);
    if (unrealized < 0) {
      const cur = harvestMap.get(sym) ?? { quantity: 0, loss: 0 };
      cur.quantity += lot.quantity;
      cur.loss += unrealized;
      harvestMap.set(sym, cur);
    }
  }
  const harvestCandidates: HarvestCandidate[] = Array.from(harvestMap.entries())
    .map(([symbol, v]) => ({ symbol, quantity: v.quantity, unrealizedLoss: Number(v.loss.toFixed(2)) }))
    .sort((a, b) => a.unrealizedLoss - b.unrealizedLoss);

  return {
    taxYear,
    shortTermRealized: Number(shortTermRealized.toFixed(2)),
    longTermRealized: Number(longTermRealized.toFixed(2)),
    totalRealized: Number((shortTermRealized + longTermRealized).toFixed(2)),
    disallowedWashSaleLoss: Number(washSales.reduce((s, w) => s + w.disallowedLoss, 0).toFixed(2)),
    estimatedShortTermTax: Number(estimatedShortTermTax.toFixed(2)),
    estimatedLongTermTax: Number(estimatedLongTermTax.toFixed(2)),
    estimatedTaxLiability: Number((estimatedShortTermTax + estimatedLongTermTax).toFixed(2)),
    washSales,
    lockedSymbols: tax.washSaleGuard
      ? Array.from(getWashSaleLockedSymbols(accountNumber, source, now, userId, prefetched, tax.washSaleMinLossUsd, prefetchedPnl))
      : [],
    openLots,
    harvestCandidates,
    settings: tax
  };
}
