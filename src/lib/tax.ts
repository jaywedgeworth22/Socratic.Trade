import { DEFAULT_TAX_SETTINGS } from "./defaults";
import { listFillEvents } from "./db";
import { normalizeSymbol } from "./money";
import { getClosedLotsDetailed, getOpenLots, type ClosedLot } from "./performance";
import type { FillEvent, FillSource, TaxSettings } from "./types";

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

export function resolveTaxSettings(settings?: TaxSettings): TaxSettings {
  return { ...DEFAULT_TAX_SETTINGS, ...(settings ?? {}) };
}

function holdingDays(entryAt: string | undefined, exitAt: string | undefined): number {
  if (!entryAt || !exitAt) return 0;
  const ms = new Date(exitAt).getTime() - new Date(entryAt).getTime();
  return Number.isFinite(ms) ? Math.max(0, ms / MS_PER_DAY) : 0;
}

/**
 * Symbols currently inside a 30-day wash-sale lockout: a LONG position in the symbol
 * was closed at a LOSS within the last 30 days, so rebuying now (within the 61-day
 * window) would create a wash sale and disallow that loss (IRC §1091). Used by the
 * policy guardrail to block new buys.
 */
export function getWashSaleLockedSymbols(accountNumber: string, source: FillSource, now = new Date()): Set<string> {
  const locked = new Set<string>();
  const cutoff = now.getTime() - WASH_WINDOW_DAYS * MS_PER_DAY;
  for (const lot of getClosedLotsDetailed(accountNumber, source)) {
    if (lot.pnl >= 0 || lot.side !== "long" || !lot.exitAt || !lot.symbol) continue;
    const exitT = new Date(lot.exitAt).getTime();
    if (Number.isFinite(exitT) && exitT >= cutoff && exitT <= now.getTime()) locked.add(normalizeSymbol(lot.symbol));
  }
  return locked;
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
  settings?: TaxSettings,
  now = new Date()
): TaxSummary {
  const tax = resolveTaxSettings(settings);
  const taxYear = now.getFullYear();
  const fills = listFillEvents(accountNumber, source);
  const closedLots = getClosedLotsDetailed(accountNumber, source);
  const openLotsRaw = getOpenLots(accountNumber, source);

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
      return {
        symbol: normalizeSymbol(lot.symbol),
        quantity: lot.quantity, // keep full share precision in the record; the UI formats for display
        entryAt: lot.entryAt,
        daysHeld: Math.floor(days),
        daysToLongTerm: Math.max(0, Math.ceil(LONG_TERM_DAYS - days)),
        isLongTerm: days > LONG_TERM_DAYS
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
    lockedSymbols: Array.from(getWashSaleLockedSymbols(accountNumber, source, now)),
    openLots,
    harvestCandidates,
    settings: tax
  };
}
