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

interface ClosedLot {
  pnl: number;
  returnPct: number;
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
    if (fill.side === "buy") {
      const fillCost = fill.quantity * fill.price;
      const currentCost = current.averageCost * current.quantity;
      const nextQuantity = current.quantity + fill.quantity;
      const nextAverageCost = nextQuantity > 0 ? (currentCost + fillCost) / nextQuantity : fill.price;
      positions.set(symbol, { ...current, quantity: nextQuantity, averageCost: nextAverageCost, marketValue: 0 });
      cash -= fillCost;
    } else {
      const soldQuantity = Math.min(current.quantity, fill.quantity);
      const nextQuantity = Math.max(0, current.quantity - soldQuantity);
      if (nextQuantity <= 0.000001) positions.delete(symbol);
      else positions.set(symbol, { ...current, quantity: nextQuantity });
      cash += soldQuantity * fill.price;
    }
  }

  // Mark open positions to live prices (fall back to average cost when a price is missing).
  const projectedPositions = Array.from(positions.values())
    .filter((position) => position.quantity > 0.000001)
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
  const lots = new Map<string, Array<{ quantity: number; price: number; runId?: string }>>();
  const closedLots: ClosedLot[] = [];
  const attribution = new Map<string, RunAttribution>();
  let realized = 0;

  for (const fill of fills.filter(isAccountingFill).sort((a, b) => a.filledAt.localeCompare(b.filledAt))) {
    const symbol = normalizeSymbol(fill.symbol);
    if (!lots.has(symbol)) lots.set(symbol, []);

    if (fill.side === "buy") {
      lots.get(symbol)!.push({ quantity: fill.quantity, price: fill.price, runId: fill.runId });
      addAttribution(attribution, fill, 0);
      continue;
    }

    let remaining = fill.quantity;
    while (remaining > 0 && lots.get(symbol)!.length > 0) {
      const lot = lots.get(symbol)![0];
      const matched = Math.min(remaining, lot.quantity);
      const pnl = matched * (fill.price - lot.price);
      const returnPct = lot.price > 0 ? ((fill.price - lot.price) / lot.price) * 100 : 0;
      realized += pnl;
      closedLots.push({ pnl, returnPct });
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
    for (const lot of symbolLots) unrealized += lot.quantity * (current - lot.price);
  }

  return {
    realized,
    unrealized,
    closedLots,
    attribution: Array.from(attribution.values()).sort((a, b) => a.runId.localeCompare(b.runId))
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
