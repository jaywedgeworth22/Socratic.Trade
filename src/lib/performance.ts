import { insertFillEvent, insertPortfolioSnapshot, listFillEvents, listPortfolioSnapshots } from "./db";
import { normalizeSymbol } from "./money";
import type {
  EquityPosition,
  ExecutedOrder,
  FillEvent,
  FillSource,
  MarketScan,
  PerformanceSummary,
  Portfolio,
  ReviewedOrder,
  RunAttribution,
  TradeProposal
} from "./types";

export interface ClosedLot {
  pnl: number;
  returnPct: number;
  symbol?: string;
  thesisTag?: string;
  regime?: string;
  side?: "long" | "short";
  entryPrice?: number;
  entryAt?: string;
  exitAt?: string;
}

/** Realized-outcome stats grouped by the thesis a position was opened under. */
export interface ThesisStat {
  thesisTag: string;
  trades: number;
  winRate: number;
  avgReturnPct: number;
  totalPnl: number;
}

/** Realized-outcome stats grouped by the market regime a position was opened in. */
export interface RegimeStat {
  regime: string;
  trades: number;
  winRate: number;
  avgReturnPct: number;
  totalPnl: number;
}

interface PnlResult {
  realized: number;
  unrealized: number;
  closedLots: ClosedLot[];
  attribution: RunAttribution[];
}

export function recordPortfolioSnapshot(input: {
  runId?: string;
  accountNumber: string;
  source: FillSource;
  portfolio: Portfolio;
  positions: EquityPosition[];
}) {
  return insertPortfolioSnapshot({
    runId: input.runId,
    accountNumber: input.accountNumber,
    source: input.source,
    equity: input.portfolio.totalMarketValue,
    cash: input.portfolio.cash,
    buyingPower: input.portfolio.buyingPower,
    positionsValue: input.portfolio.equityMarketValue,
    positions: input.positions
  });
}

export function recordFillFromProposal(input: {
  accountNumber: string;
  proposalId?: string;
  runId?: string;
  source: FillSource;
  proposal: TradeProposal;
  review?: ReviewedOrder;
  execution?: ExecutedOrder;
  marketScan?: MarketScan;
  status?: string;
}): FillEvent {
  const symbol = normalizeSymbol(input.proposal.symbol);
  const marketPrice = input.marketScan?.quotesBySymbol[symbol]?.price;
  const executionPrice = input.execution?.averagePrice;
  const proposedPrice = input.proposal.limitPrice ?? input.proposal.stopPrice;
  const notional = input.review?.estimatedNotional ?? input.proposal.dollarAmount ?? 0;
  const quantityInput = positiveNumber(input.execution?.filledQuantity) ?? positiveNumber(input.proposal.quantity);
  const impliedPrice = quantityInput && notional > 0 ? notional / quantityInput : undefined;
  const reviewPrice = priceFromReview(input.review?.raw);
  const price =
    positiveNumber(executionPrice) ??
    positiveNumber(proposedPrice) ??
    positiveNumber(marketPrice) ??
    positiveNumber(reviewPrice) ??
    positiveNumber(impliedPrice) ??
    0;
  const quantity =
    quantityInput ?? (price > 0 && notional > 0 ? notional / price : 0);
  const finalNotional =
    quantity > 0 && price > 0
      ? quantity * price
      : input.proposal.dollarAmount ?? (notional > 0 ? notional : 0);

  return insertFillEvent({
    proposalId: input.proposalId,
    runId: input.runId,
    accountNumber: input.accountNumber,
    source: input.source,
    symbol,
    side: input.proposal.side,
    quantity,
    price,
    notional: Math.abs(finalNotional),
    status: input.status ?? (input.source === "paper" ? "filled" : "pending_reconciliation"),
    brokerOrderId: input.execution?.orderId,
    raw: { proposal: input.proposal, review: input.review, execution: input.execution }
  });
}

export function getPerformanceSummary(accountNumber: string, currentPrices: Record<string, number> = {}): PerformanceSummary {
  const liveFills = listFillEvents(accountNumber, "live");
  const paperFills = listFillEvents(accountNumber, "paper");
  const allFills = [...liveFills, ...paperFills].sort((a, b) => a.filledAt.localeCompare(b.filledAt));
  const livePnl = calculatePnl(liveFills, currentPrices);
  const paperPnl = calculatePnl(paperFills, currentPrices);
  const liveSnapshots = listPortfolioSnapshots(accountNumber, "live");
  const paperSnapshots = listPortfolioSnapshots(accountNumber, "paper");

  return {
    liveEquityCurve: liveSnapshots.map((snapshot) => ({
      timestamp: snapshot.createdAt,
      equity: snapshot.equity,
      source: "live"
    })),
    paperEquityCurve:
      paperSnapshots.length > 0
        ? paperSnapshots.map((snapshot) => ({ timestamp: snapshot.createdAt, equity: snapshot.equity, source: "paper" }))
        : syntheticPaperCurve(paperFills),
    liveRealizedPnl: livePnl.realized,
    paperRealizedPnl: paperPnl.realized,
    liveUnrealizedPnl: livePnl.unrealized,
    paperUnrealizedPnl: paperPnl.unrealized,
    liveWinRate: winRate(livePnl.closedLots),
    paperWinRate: winRate(paperPnl.closedLots),
    liveAverageReturnPct: averageReturn(livePnl.closedLots),
    paperAverageReturnPct: averageReturn(paperPnl.closedLots),
    attribution: combineAttribution(livePnl.attribution, paperPnl.attribution),
    fills: allFills.slice(-100)
  };
}

// Standalone paper account: starts from a fixed paper cash balance (independent of the
// real brokerage account), applies all paper fills, and marks open positions to the
// supplied live prices so unrealized P&L and equity reflect the real market.
export function getPaperPortfolioProjection(input: {
  accountNumber: string;
  startingCash: number;
  currentPrices?: Record<string, number>;
}): { portfolio: Portfolio; positions: EquityPosition[] } {
  const paperFills = listFillEvents(input.accountNumber, "paper").filter(isAccountingFill);
  const prices = input.currentPrices ?? {};
  const positions = new Map<string, EquityPosition>();
  let cash = input.startingCash;

  for (const fill of paperFills.sort((a, b) => a.filledAt.localeCompare(b.filledAt))) {
    if (fill.quantity <= 0 || fill.price <= 0) continue;
    const symbol = normalizeSymbol(fill.symbol);
    const current = positions.get(symbol) ?? { symbol, quantity: 0, averageCost: 0, marketValue: 0 };
    if (fill.side === "buy" || fill.side === "short") {
      const isShort = fill.side === "short";
      const quantityChange = isShort ? -fill.quantity : fill.quantity;
      const fillCost = fill.quantity * fill.price;
      const currentCost = current.averageCost * Math.abs(current.quantity);
      const nextQuantity = current.quantity + quantityChange;
      const nextAbsQuantity = Math.abs(nextQuantity);
      
      const nextAverageCost = nextAbsQuantity > 0 ? (currentCost + fillCost) / nextAbsQuantity : fill.price;
      positions.set(symbol, { ...current, quantity: nextQuantity, averageCost: nextAverageCost, marketValue: 0 });
      cash += isShort ? fillCost : -fillCost;
    } else {
      const isCover = fill.side === "cover";
      const matchedQuantity = Math.min(Math.abs(current.quantity), fill.quantity);
      const quantityChange = isCover ? matchedQuantity : -matchedQuantity;
      const nextQuantity = current.quantity + quantityChange;
      
      if (Math.abs(nextQuantity) <= 0.000001) positions.delete(symbol);
      else positions.set(symbol, { ...current, quantity: nextQuantity });
      cash += isCover ? -matchedQuantity * fill.price : matchedQuantity * fill.price;
    }
  }

  // Mark open positions to live prices (fall back to average cost when a price is missing).
  const projectedPositions = Array.from(positions.values())
    .filter((position) => Math.abs(position.quantity) > 0.000001)
    .map((position) => {
      const mark = prices[normalizeSymbol(position.symbol)] ?? position.averageCost;
      return { ...position, marketValue: position.quantity * mark };
    });
  const equityMarketValue = projectedPositions.reduce((sum, position) => sum + position.marketValue, 0);
  const totalMarketValue = cash + equityMarketValue;

  return {
    positions: projectedPositions,
    portfolio: {
      accountNumber: input.accountNumber,
      cash,
      buyingPower: Math.max(0, cash),
      equityMarketValue,
      optionMarketValue: 0,
      totalMarketValue
    }
  };
}

export function calculatePnl(fills: FillEvent[], currentPrices: Record<string, number> = {}): PnlResult {
  const lots = new Map<
    string,
    Array<{
      quantity: number;
      price: number;
      runId?: string;
      side: "long" | "short";
      thesisTag?: string;
      regime?: string;
      entryAt?: string;
    }>
  >();
  const closedLots: ClosedLot[] = [];
  const attribution = new Map<string, RunAttribution>();
  let realized = 0;

  for (const fill of fills.filter(isAccountingFill).sort((a, b) => a.filledAt.localeCompare(b.filledAt))) {
    const symbol = normalizeSymbol(fill.symbol);
    if (!lots.has(symbol)) lots.set(symbol, []);

    if (fill.side === "buy" || fill.side === "short") {
      const meta = thesisMetaFromFill(fill);
      lots.get(symbol)!.push({
        quantity: fill.quantity,
        price: fill.price,
        runId: fill.runId,
        side: fill.side === "buy" ? "long" : "short",
        thesisTag: meta.thesisTag,
        regime: meta.regime,
        entryAt: fill.filledAt
      });
      addAttribution(attribution, fill, 0);
      continue;
    }

    let remaining = fill.quantity;
    while (remaining > 0 && lots.get(symbol)!.length > 0) {
      const lot = lots.get(symbol)![0];
      const matched = Math.min(remaining, lot.quantity);
      let pnl = 0;
      let returnPct = 0;
      if (fill.side === "sell" && lot.side === "long") {
        pnl = matched * (fill.price - lot.price);
        returnPct = lot.price > 0 ? ((fill.price - lot.price) / lot.price) * 100 : 0;
      } else if (fill.side === "cover" && lot.side === "short") {
        pnl = matched * (lot.price - fill.price);
        returnPct = lot.price > 0 ? ((lot.price - fill.price) / lot.price) * 100 : 0;
      }
      realized += pnl;
      // Attribute the realized outcome to the thesis/regime the lot was *opened* under,
      // and carry entry/exit context for excursion (MAE/MFE) analysis.
      closedLots.push({
        pnl,
        returnPct,
        symbol,
        thesisTag: lot.thesisTag,
        regime: lot.regime,
        side: lot.side,
        entryPrice: lot.price,
        entryAt: lot.entryAt,
        exitAt: fill.filledAt
      });
      addAttribution(attribution, fill, pnl);
      lot.quantity -= matched;
      remaining -= matched;
      if (lot.quantity <= 0.000001) lots.get(symbol)!.shift();
    }
  }

  let unrealized = 0;
  for (const [symbol, symbolLots] of lots) {
    const current = currentPrices[symbol];
    if (!current) continue;
    for (const lot of symbolLots) {
      if (lot.side === "long") {
        unrealized += lot.quantity * (current - lot.price);
      } else {
        unrealized += lot.quantity * (lot.price - current);
      }
    }
  }

  return {
    realized,
    unrealized,
    closedLots,
    attribution: Array.from(attribution.values()).sort((a, b) => a.runId.localeCompare(b.runId))
  };
}

/**
 * Per-thesis realized-outcome scorecard for the learning loop: how each
 * `tradeThesisTag` has actually performed once positions closed. Computed
 * deterministically in code (no LLM tokens) so it can be fed back to the agent
 * cheaply as high-signal "what has worked vs lost" context.
 */
export function getThesisScorecard(
  accountNumber: string,
  source?: FillSource,
  currentPrices: Record<string, number> = {}
): ThesisStat[] {
  const { closedLots } = calculatePnl(listFillEvents(accountNumber, source), currentPrices);
  return aggregateClosedLots(closedLots, (lot) =>
    lot.thesisTag && lot.thesisTag.trim() ? lot.thesisTag.trim() : "Untagged"
  ).map(({ key, ...rest }) => ({ thesisTag: key, ...rest }));
}

export function getRegimeScorecard(
  accountNumber: string,
  source?: FillSource,
  currentPrices: Record<string, number> = {}
): RegimeStat[] {
  const { closedLots } = calculatePnl(listFillEvents(accountNumber, source), currentPrices);
  return aggregateClosedLots(closedLots, (lot) =>
    lot.regime && lot.regime.trim() ? lot.regime.trim() : "Unspecified"
  ).map(({ key, ...rest }) => ({ regime: key, ...rest }));
}

/** Closed lots with entry/exit context, oldest-first, for excursion (MAE/MFE) analysis. */
export function getClosedLotsDetailed(accountNumber: string, source?: FillSource): ClosedLot[] {
  return calculatePnl(listFillEvents(accountNumber, source)).closedLots;
}

function aggregateClosedLots(
  closedLots: ClosedLot[],
  keyFn: (lot: ClosedLot) => string
): Array<{ key: string; trades: number; winRate: number; avgReturnPct: number; totalPnl: number }> {
  const byKey = new Map<string, { pnl: number; returnSum: number; wins: number; trades: number }>();
  for (const lot of closedLots) {
    const key = keyFn(lot);
    const cur = byKey.get(key) ?? { pnl: 0, returnSum: 0, wins: 0, trades: 0 };
    cur.pnl += lot.pnl;
    cur.returnSum += lot.returnPct;
    cur.wins += lot.pnl > 0 ? 1 : 0;
    cur.trades += 1;
    byKey.set(key, cur);
  }
  return Array.from(byKey.entries())
    .map(([key, s]) => ({
      key,
      trades: s.trades,
      winRate: Math.round((s.wins / s.trades) * 100),
      avgReturnPct: Number((s.returnSum / s.trades).toFixed(2)),
      totalPnl: Number(s.pnl.toFixed(2))
    }))
    .sort((a, b) => b.totalPnl - a.totalPnl);
}

function thesisMetaFromFill(fill: FillEvent): { thesisTag?: string; regime?: string } {
  const raw = fill.raw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const proposal = (raw as Record<string, unknown>).proposal;
  if (!proposal || typeof proposal !== "object") return {};
  const p = proposal as Record<string, unknown>;
  return {
    thesisTag: typeof p.tradeThesisTag === "string" ? p.tradeThesisTag : undefined,
    regime: typeof p.entryMarketRegime === "string" ? p.entryMarketRegime : undefined
  };
}

function isAccountingFill(fill: FillEvent): boolean {
  return fill.status === "filled" || fill.source === "paper";
}

function syntheticPaperCurve(fills: FillEvent[]) {
  const accountingFills = fills
    .filter(isAccountingFill)
    .sort((a, b) => a.filledAt.localeCompare(b.filledAt));
  return accountingFills.map((fill, index) => {
    const realized = calculatePnl(accountingFills.slice(0, index + 1)).realized;
    return { timestamp: fill.filledAt, equity: 100 + realized, source: "paper" as const };
  });
}

function addAttribution(map: Map<string, RunAttribution>, fill: FillEvent, realizedPnl: number): void {
  const runId = fill.runId ?? "manual";
  const current = map.get(runId) ?? { runId, fillCount: 0, notional: 0, realizedPnl: 0 };
  current.fillCount += 1;
  current.notional += fill.notional;
  current.realizedPnl += realizedPnl;
  map.set(runId, current);
}

function combineAttribution(...groups: RunAttribution[][]): RunAttribution[] {
  const map = new Map<string, RunAttribution>();
  for (const group of groups) {
    for (const item of group) {
      const current = map.get(item.runId) ?? { runId: item.runId, fillCount: 0, notional: 0, realizedPnl: 0 };
      current.fillCount += item.fillCount;
      current.notional += item.notional;
      current.realizedPnl += item.realizedPnl;
      map.set(item.runId, current);
    }
  }
  return Array.from(map.values()).sort((a, b) => b.notional - a.notional);
}

function winRate(lots: ClosedLot[]): number {
  if (lots.length === 0) return 0;
  return (lots.filter((lot) => lot.pnl > 0).length / lots.length) * 100;
}

function averageReturn(lots: ClosedLot[]): number {
  if (lots.length === 0) return 0;
  return lots.reduce((sum, lot) => sum + lot.returnPct, 0) / lots.length;
}

function positiveNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function priceFromReview(raw: unknown): number | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  return (
    positiveNumber(row.estimatedPrice) ??
    positiveNumber(row.estimated_price) ??
    positiveNumber(row.averagePrice) ??
    positiveNumber(row.average_price) ??
    positiveNumber(row.lastPrice) ??
    positiveNumber(row.last_price) ??
    positiveNumber(row.last_trade_price) ??
    positiveNumber(row.price)
  );
}
