import { getPolicy, insertFillEvent, insertPortfolioSnapshot, listAudit, listFillEvents, listMaturedSkippedCounterfactuals, listPortfolioSnapshots } from "./db";
import { applyExecutionCost, estimateExecutionCostBps, executionCostConfig } from "./execution-cost";
import { normalizeSymbol } from "./money";
import type {
  EquityPosition,
  ExecutedOrder,
  ExecutionMode,
  FillEvent,
  FillSource,
  MarketFactor,
  MarketFactorBreakdown,
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
  /** Run that opened this lot — joins to the per-run `signal_snapshot` audit for efficacy analysis. */
  entryRunId?: string;
  /** Agent confidence (1–100) assigned to the opening proposal, for calibration analysis. */
  confidence?: number;
  /** Sector the position was opened in (stamped at fill time), for the sector dimension. */
  sector?: string;
  /** Max Adverse Excursion (% from entry price, typically negative for longs) persisted after post-mortem. */
  mae?: number;
  /** Max Favorable Excursion (% from entry price, typically positive for longs) persisted after post-mortem. */
  mfe?: number;
}

/** Realized-outcome stats grouped by the thesis a position was opened under. */
export interface ThesisStat {
  thesisTag: string;
  trades: number;
  winRate: number;
  avgReturnPct: number;
  totalPnl: number;
  shrunkWinRate: number;
  shrunkAvgReturnPct: number;
  /** Average calendar days held; undefined when lots lack entryAt/exitAt timestamps. */
  avgDaysHeld?: number;
  /** % of lots held < 365 days (short-term capital gains); undefined when no timestamp data. */
  shortTermPct?: number;
}

/** Realized-outcome stats grouped by the market regime a position was opened in. */
export interface RegimeStat {
  regime: string;
  trades: number;
  winRate: number;
  avgReturnPct: number;
  totalPnl: number;
  shrunkWinRate: number;
  shrunkAvgReturnPct: number;
  avgDaysHeld?: number;
  shortTermPct?: number;
}

/** An open (unclosed) tax lot with its entry date, for holding-period / tax analysis. */
export interface OpenLot {
  symbol: string;
  quantity: number;
  entryPrice: number;
  side: "long" | "short";
  entryAt?: string;
}

interface PnlResult {
  realized: number;
  unrealized: number;
  closedLots: ClosedLot[];
  openLots: OpenLot[];
  attribution: RunAttribution[];
}

export function recordPortfolioSnapshot(input: {
  userId?: string;
  runId?: string;
  accountNumber: string;
  source: FillSource;
  executionMode?: ExecutionMode;
  portfolio: Portfolio;
  positions: EquityPosition[];
}) {
  return insertPortfolioSnapshot({
    userId: input.userId,
    runId: input.runId,
    accountNumber: input.accountNumber,
    source: input.source,
    executionMode: input.executionMode,
    equity: input.portfolio.totalMarketValue,
    cash: input.portfolio.cash,
    buyingPower: input.portfolio.buyingPower,
    positionsValue: input.portfolio.equityMarketValue,
    positions: input.positions
  });
}

export function recordFillFromProposal(input: {
  userId?: string;
  accountNumber: string;
  proposalId?: string;
  runId?: string;
  source: FillSource;
  executionMode?: ExecutionMode;
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
  const basePrice =
    positiveNumber(executionPrice) ??
    positiveNumber(proposedPrice) ??
    positiveNumber(marketPrice) ??
    positiveNumber(reviewPrice) ??
    positiveNumber(impliedPrice) ??
    0;
  // Deterministic execution-cost model for SIMULATED fills (default ON). Real broker (live) fills
  // already carry their realized price, so only paper fills are adjusted — this makes the learning
  // loop net-of-cost rather than certifying a frictionless edge that won't survive a live fill.
  // Disable by setting PAPER_EXECUTION_COST_MODEL=off.
  const costCfg = executionCostConfig();
  let price = basePrice;
  if (costCfg.enabled && input.source === "paper" && basePrice > 0) {
    // bid/ask come from either the trimmed summary or the full candidate; daily volume (for the
    // sqrt-impact term) is only on the full topCandidates quote. When the symbol isn't a scan
    // candidate (e.g. an exit of a held name) the impact term is simply omitted.
    const full = input.marketScan?.topCandidates.find((c) => normalizeSymbol(c.symbol) === symbol);
    const summary = input.marketScan?.quotesBySymbol[symbol];
    const bid = full?.bid ?? summary?.bid;
    const ask = full?.ask ?? summary?.ask;
    const spreadBps =
      typeof bid === "number" && typeof ask === "number" && bid > 0 && ask > 0
        ? ((ask - bid) / ((ask + bid) / 2)) * 1e4
        : undefined;
    const dollarVol = full && full.price > 0 && full.volume > 0 ? full.price * full.volume : undefined;
    const orderNotional = (quantityInput && quantityInput > 0 ? quantityInput * basePrice : notional) || 0;
    const costBps = estimateExecutionCostBps({
      spreadBps,
      orderNotional,
      dollarVol,
      baseSlippageBps: costCfg.baseSlippageBps,
      impactCoeff: costCfg.impactCoeff
    });
    price = applyExecutionCost(basePrice, input.proposal.side, costBps);
  }
  const quantity =
    quantityInput ?? (price > 0 && notional > 0 ? notional / price : 0);
  const finalNotional =
    quantity > 0 && price > 0
      ? quantity * price
      : input.proposal.dollarAmount ?? (notional > 0 ? notional : 0);

  return insertFillEvent({
    userId: input.userId,
    proposalId: input.proposalId,
    runId: input.runId,
    accountNumber: input.accountNumber,
    source: input.source,
    executionMode: input.executionMode,
    symbol,
    side: input.proposal.side,
    quantity,
    price,
    notional: Math.abs(finalNotional),
    status: input.status ?? (input.source === "paper" ? "filled" : "pending_reconciliation"),
    brokerOrderId: input.execution?.orderId,
    // Stamp the symbol's sector at fill time so closed lots can be grouped by sector
    // for the sector learning dimension (sector isn't on the proposal itself).
    raw: { proposal: input.proposal, review: input.review, execution: input.execution, sector: input.marketScan?.quotesBySymbol[symbol]?.sector }
  });
}

export function getPerformanceSummary(accountNumber: string, currentPrices: Record<string, number> = {}, userId: string = "local"): PerformanceSummary {
  const liveFills = listFillEvents(accountNumber, "live", 500, userId);
  const paperFills = listFillEvents(accountNumber, "paper", 500, userId);
  const allFills = [...liveFills, ...paperFills].sort((a, b) => a.filledAt.localeCompare(b.filledAt));
  const livePnl = calculatePnl(liveFills, currentPrices);
  const paperPnl = calculatePnl(paperFills, currentPrices);
  const liveSnapshots = listPortfolioSnapshots(accountNumber, "live", 100, userId);
  const paperSnapshots = listPortfolioSnapshots(accountNumber, "paper", 100, userId);

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
  userId?: string;
}): { portfolio: Portfolio; positions: EquityPosition[] } {
  const paperFills = listFillEvents(input.accountNumber, "paper", 500, input.userId ?? "local").filter(isAccountingFill);
  const prices = input.currentPrices ?? {};
  const positions = new Map<string, EquityPosition>();
  let cash = input.startingCash;

  for (const fill of paperFills.sort((a, b) => a.filledAt.localeCompare(b.filledAt))) {
    if (fill.quantity <= 0 || fill.price <= 0) continue;
    const symbol = normalizeSymbol(fill.symbol);
    const current = positions.get(symbol) ?? { symbol, quantity: 0, averageCost: 0, marketValue: 0 };
    const q = current.quantity;
    if (fill.side === "buy" || fill.side === "short") {
      // Opening side: a `buy` increases quantity (+), a `short` decreases it (-). When the fill
      // lands on an OPPOSITE-side position it closes that position first (and may flip past zero);
      // it must NOT blend opposite-side cost into averageCost — averageCost is only re-weighted on
      // a same-side increase, left intact on a partial opposite-side close, and re-based to the fill
      // price on a flip. (T5: opposite-side averaging guard.)
      const isShort = fill.side === "short";
      const dir = isShort ? -1 : 1;
      const fillCost = fill.quantity * fill.price;
      const nextQuantity = q + dir * fill.quantity;
      const nextAbsQuantity = Math.abs(nextQuantity);
      const sameSide = q === 0 || Math.sign(q) === dir;
      let nextAverageCost: number;
      if (sameSide) {
        const currentCost = current.averageCost * Math.abs(q);
        nextAverageCost = nextAbsQuantity > 0.000001 ? (currentCost + fillCost) / nextAbsQuantity : fill.price;
      } else if (nextAbsQuantity <= 0.000001) {
        nextAverageCost = 0; // fully closed the opposite-side position
      } else if (Math.sign(nextQuantity) === Math.sign(q)) {
        nextAverageCost = current.averageCost; // partial close of the opposite side; remaining basis unchanged
      } else {
        nextAverageCost = fill.price; // flipped: the excess opens a fresh position at the fill price
      }
      if (nextAbsQuantity <= 0.000001) positions.delete(symbol);
      else positions.set(symbol, { ...current, quantity: nextQuantity, averageCost: nextAverageCost, marketValue: 0 });
      cash += isShort ? fillCost : -fillCost;
    } else {
      // Closing side: a `sell` may only reduce a LONG, a `cover` only a SHORT. A wrong-sign or flat
      // close (sell with no long / cover with no short) matches nothing and is skipped — never deepen
      // the opposite-side position. (T5: wrong-sign/flat close guard.)
      const isCover = fill.side === "cover";
      const sameSide = isCover ? q < 0 : q > 0;
      if (!sameSide) continue;
      const matchedQuantity = Math.min(Math.abs(q), fill.quantity);
      const nextQuantity = q + (isCover ? matchedQuantity : -matchedQuantity);
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
      confidence?: number;
      sector?: string;
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
        confidence: meta.confidence,
        sector: meta.sector,
        entryAt: fill.filledAt
      });
      addAttribution(attribution, fill, 0);
      continue;
    }

    // A closing fill matches only OPENING lots of the correct side: a "sell" closes
    // "long" lots, a "cover" closes "short" lots. Select the first SAME-SIDE lot (FIFO)
    // and skip opposite-side lots — never consume an opposite-side lot at $0 P&L, which
    // would silently erase a real open position from the books.
    const wantSide: "long" | "short" = fill.side === "cover" ? "short" : "long";
    let remaining = fill.quantity;
    const symbolLots = lots.get(symbol)!;
    while (remaining > 0) {
      const idx = symbolLots.findIndex((l) => l.side === wantSide);
      if (idx === -1) break; // no matching open lot to close against
      const lot = symbolLots[idx];
      const matched = Math.min(remaining, lot.quantity);
      const pnl = fill.side === "cover"
        ? matched * (lot.price - fill.price)
        : matched * (fill.price - lot.price);
      const returnPct = lot.price > 0
        ? (fill.side === "cover" ? (lot.price - fill.price) / lot.price : (fill.price - lot.price) / lot.price) * 100
        : 0;
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
        exitAt: fill.filledAt,
        entryRunId: lot.runId,
        confidence: lot.confidence,
        sector: lot.sector
      });
      addAttribution(attribution, fill, pnl);
      lot.quantity -= matched;
      remaining -= matched;
      if (lot.quantity <= 0.000001) symbolLots.splice(idx, 1);
    }
  }

  let unrealized = 0;
  const openLots: OpenLot[] = [];
  for (const [symbol, symbolLots] of lots) {
    const current = currentPrices[symbol];
    for (const lot of symbolLots) {
      if (Math.abs(lot.quantity) > 0.000001) {
        // Signed quantity: positive for longs, negative for shorts (matches EquityPosition convention)
        const signedQty = lot.side === "short" ? -lot.quantity : lot.quantity;
        openLots.push({ symbol, quantity: signedQty, entryPrice: lot.price, side: lot.side, entryAt: lot.entryAt });
      }
      if (!current) continue;
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
    openLots,
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
  currentPrices: Record<string, number> = {},
  userId: string = "local"
): ThesisStat[] {
  const { closedLots } = calculatePnl(listFillEvents(accountNumber, source, 500, userId), currentPrices);
  return aggregateClosedLots(
    closedLots,
    (lot) => (lot.thesisTag && lot.thesisTag.trim() ? lot.thesisTag.trim() : "Untagged"),
    userId
  ).map(({ key, ...rest }) => ({ thesisTag: key, ...rest }));
}

export function getRegimeScorecard(
  accountNumber: string,
  source?: FillSource,
  currentPrices: Record<string, number> = {},
  userId: string = "local"
): RegimeStat[] {
  const { closedLots } = calculatePnl(listFillEvents(accountNumber, source, 500, userId), currentPrices);
  return aggregateClosedLots(
    closedLots,
    (lot) => (lot.regime && lot.regime.trim() ? lot.regime.trim() : "Unspecified"),
    userId
  ).map(({ key, ...rest }) => ({ regime: key, ...rest }));
}

/** Realized-outcome stats grouped by the sector a position was opened in. */
export interface SectorStat {
  sector: string;
  trades: number;
  winRate: number;
  avgReturnPct: number;
  totalPnl: number;
  shrunkWinRate: number;
  shrunkAvgReturnPct: number;
  avgDaysHeld?: number;
  shortTermPct?: number;
}

export function getSectorScorecard(
  accountNumber: string,
  source?: FillSource,
  currentPrices: Record<string, number> = {},
  userId: string = "local"
): SectorStat[] {
  const { closedLots } = calculatePnl(listFillEvents(accountNumber, source, 500, userId), currentPrices);
  return aggregateClosedLots(
    closedLots,
    (lot) => (lot.sector && lot.sector.trim() ? lot.sector.trim() : "Unknown"),
    userId
  ).map(({ key, ...rest }) => ({ sector: key, ...rest }));
}

/** Closed lots with entry/exit context, oldest-first, for excursion (MAE/MFE) analysis. */
export function getClosedLotsDetailed(accountNumber: string, source?: FillSource, userId: string = "local"): ClosedLot[] {
  return calculatePnl(listFillEvents(accountNumber, source, 500, userId)).closedLots;
}

/**
 * Combined thesis × regime realized scorecard — the multi-dimensional learning
 * bucket. A thesis that wins in a Tech-Bull regime may lose in a High-Vol regime;
 * crossing the two surfaces those conditional edges. Shrunk like the 1-D cards so
 * thin buckets don't mislead. (Sector is a further dimension but isn't reliably
 * carried on closed lots yet — see docs/phase-9-web-sources.md follow-ups.)
 */
export interface ThesisRegimeStat {
  thesisTag: string;
  regime: string;
  trades: number;
  winRate: number;
  avgReturnPct: number;
  totalPnl: number;
  shrunkWinRate: number;
  shrunkAvgReturnPct: number;
  avgDaysHeld?: number;
  shortTermPct?: number;
}

const THESIS_REGIME_SEP = " @ ";

export function getThesisRegimeScorecard(
  accountNumber: string,
  source?: FillSource,
  currentPrices: Record<string, number> = {},
  userId: string = "local"
): ThesisRegimeStat[] {
  const { closedLots } = calculatePnl(listFillEvents(accountNumber, source, 500, userId), currentPrices);
  return aggregateClosedLots(closedLots, (lot) => {
    const thesis = lot.thesisTag?.trim() || "Untagged";
    const regime = lot.regime?.trim() || "Unspecified";
    return `${thesis}${THESIS_REGIME_SEP}${regime}`;
  }, userId).map(({ key, ...rest }) => {
    const sep = key.indexOf(THESIS_REGIME_SEP);
    return { thesisTag: key.slice(0, sep), regime: key.slice(sep + THESIS_REGIME_SEP.length), ...rest };
  });
}

/** Number of closed (realized) lots — the sample size that gates learned weight shifts. */
export function getClosedLotCount(accountNumber: string, source?: FillSource, userId: string = "local"): number {
  return calculatePnl(listFillEvents(accountNumber, source, 500, userId)).closedLots.length;
}

/**
 * Realized win rate of long entries that DID vs DID NOT have a given evidence signal
 * at entry — so the agent can learn which signals actually predict winners rather than
 * trusting them on faith. Joins closed lots to the per-run `signal_snapshot` audit via
 * the opening run id. Compare each signal bucket's win rate to "All buys (baseline)".
 */
export interface SignalEfficacyStat {
  signal: string;
  trades: number;
  winRate: number;
  shrunkWinRate: number;
  avgReturnPct: number;
}

export function getSignalEfficacy(
  accountNumber: string,
  source?: FillSource,
  currentPrices: Record<string, number> = {},
  userId: string = "local"
): SignalEfficacyStat[] {
  const { closedLots } = calculatePnl(listFillEvents(accountNumber, source, 500, userId), currentPrices);
  if (closedLots.length === 0) return [];

  // runId|symbol -> entry signals, from the signal_snapshot audit trail. The snapshot
  // now records the full scored set (chosen + skipped); only CHOSEN entries can have a
  // matching closed lot, so skip the rest (older snapshots predate the flag → undefined,
  // which we keep, preserving the chosen-only behavior they had).
  const signalByKey = new Map<string, { congressNet?: number; insiderSentiment?: number }>();
  for (const event of listAudit(500, userId)) {
    if (event.kind !== "signal_snapshot") continue;
    const payload = event.payload as { runId?: string; signals?: Array<{ symbol?: string; chosen?: boolean; congressNet?: number; insiderSentiment?: number }> };
    if (!payload?.runId || !Array.isArray(payload.signals)) continue;
    for (const s of payload.signals) {
      if (!s.symbol || s.chosen === false) continue;
      signalByKey.set(`${payload.runId}|${normalizeSymbol(s.symbol)}`, { congressNet: s.congressNet, insiderSentiment: s.insiderSentiment });
    }
  }

  const buckets = new Map<string, { wins: number; trades: number; returnSum: number }>();
  const bump = (name: string, lot: ClosedLot) => {
    const b = buckets.get(name) ?? { wins: 0, trades: 0, returnSum: 0 };
    b.trades += 1;
    b.wins += lot.pnl > 0 ? 1 : 0;
    b.returnSum += lot.returnPct;
    buckets.set(name, b);
  };

  for (const lot of closedLots) {
    if (lot.side !== "long") continue; // evaluate BUY-signal efficacy
    bump("All buys (baseline)", lot);
    const sig = lot.entryRunId && lot.symbol ? signalByKey.get(`${lot.entryRunId}|${normalizeSymbol(lot.symbol)}`) : undefined;
    if (!sig) continue;
    if (typeof sig.congressNet === "number" && sig.congressNet > 0) bump("Congressional buying tailwind", lot);
    if (typeof sig.insiderSentiment === "number" && sig.insiderSentiment >= 60) bump("Insider buying tailwind", lot);
  }

  const prior = resolveShrinkPrior(userId);
  return Array.from(buckets.entries())
    .map(([signal, b]) => ({
      signal,
      trades: b.trades,
      winRate: Math.round((b.wins / b.trades) * 100),
      shrunkWinRate: Math.round(((b.wins + 0.5 * prior) / (b.trades + prior)) * 100),
      avgReturnPct: Number((b.returnSum / b.trades).toFixed(2))
    }))
    .sort((a, b) => b.trades - a.trades);
}

/** Realized-outcome stats grouped by the dominant deterministic factor at entry. */
export interface FactorScorecardStat {
  factor: MarketFactor;
  trades: number;
  winRate: number;
  avgReturnPct: number;
  totalPnl: number;
  shrunkWinRate: number;
  shrunkAvgReturnPct: number;
  /** Average calendar days held; undefined when lots lack entryAt/exitAt timestamps. */
  avgDaysHeld?: number;
  /** % of lots held < 365 days (short-term capital gains); undefined when no timestamp data. */
  shortTermPct?: number;
}

/**
 * Options for `getFactorScorecard`.
 * When `regime` is supplied, only closed lots whose `regime` field matches it are aggregated.
 * Default (no option / undefined regime): aggregate ALL closed lots regardless of regime
 * (backward-compatible behavior unchanged).
 */
export interface FactorScorecardOptions {
  regime?: string;
}

export function getFactorScorecard(
  accountNumber: string,
  source?: FillSource,
  currentPrices: Record<string, number> = {},
  userId: string = "local",
  options?: FactorScorecardOptions
): FactorScorecardStat[] {
  const { closedLots: allLots } = calculatePnl(listFillEvents(accountNumber, source, 500, userId), currentPrices);
  // Optional regime filter — default (no option) preserves the original all-lots behavior.
  const closedLots = options?.regime
    ? allLots.filter((lot) => lot.regime?.trim() === options.regime?.trim())
    : allLots;
  if (closedLots.length === 0) return [];

  const factorByKey = new Map<string, MarketFactor>();
  for (const event of listAudit(500, userId)) {
    if (event.kind !== "signal_snapshot") continue;
    const payload = event.payload as { runId?: string; signals?: Array<{ symbol?: string; chosen?: boolean; factorBreakdown?: MarketFactorBreakdown }> };
    if (!payload?.runId || !Array.isArray(payload.signals)) continue;
    for (const signal of payload.signals) {
      if (!signal.symbol || signal.chosen === false) continue;
      const factor = dominantFactor(signal.factorBreakdown);
      if (factor) factorByKey.set(`${payload.runId}|${normalizeSymbol(signal.symbol)}`, factor);
    }
  }

  const factorKey = (lot: ClosedLot) =>
    lot.entryRunId && lot.symbol ? `${lot.entryRunId}|${normalizeSymbol(lot.symbol)}` : undefined;

  return aggregateClosedLots(
    closedLots.filter((lot) => {
      const key = factorKey(lot);
      return Boolean(key && factorByKey.has(key));
    }),
    (lot) => {
      const key = factorKey(lot);
      return key ? factorByKey.get(key) ?? "momentum" : "momentum";
    },
    userId
  ).map(({ key, ...rest }) => ({ factor: key as MarketFactor, ...rest }));
}

export interface SkippedCandidateReturn {
  runId: string;
  symbol: string;
  asOf?: string;
  ageDays?: number;
  refPrice: number;
  currentPrice: number;
  returnPct: number;
  score?: number;
  sector?: string;
  regime?: string;
  dominantFactor?: MarketFactor;
  bulletins?: string[];
}

export function getSkippedCandidateReturns(
  currentPrices: Record<string, number>,
  userId: string = "local",
  options: { limit?: number; maxAgeDays?: number } = {}
): SkippedCandidateReturn[] {
  const limit = options.limit ?? 12;
  const maxAgeDays = options.maxAgeDays ?? 14;
  const now = Date.now();
  const seen = new Set<string>();
  const returns: SkippedCandidateReturn[] = listMaturedSkippedCounterfactuals(userId, limit * 3)
    .map((row): SkippedCandidateReturn | undefined => {
      if (!row.exitPrice || row.returnPct === undefined) return undefined;
      const asOfTime = new Date(row.snapshotAt).getTime();
      const ageDays = Number.isFinite(asOfTime) ? (now - asOfTime) / 86_400_000 : undefined;
      if (typeof ageDays === "number" && ageDays > maxAgeDays) return undefined;
      seen.add(row.symbol);
      return {
        runId: row.runId,
        symbol: row.symbol,
        asOf: row.snapshotAt,
        ...(typeof ageDays === "number" ? { ageDays: Number(ageDays.toFixed(1)) } : {}),
        refPrice: row.refPrice,
        currentPrice: row.exitPrice,
        returnPct: row.returnPct,
        score: row.score,
        sector: row.sector,
        regime: row.regime,
        dominantFactor: row.dominantFactor as MarketFactor | undefined,
        bulletins: row.bulletins
      };
    })
    .filter((row): row is SkippedCandidateReturn => Boolean(row));

  for (const event of listAudit(500, userId)) {
    if (event.kind !== "signal_snapshot") continue;
    const payload = event.payload as {
      runId?: string;
      asOf?: string;
      signals?: Array<{
        symbol?: string;
        chosen?: boolean;
        refPrice?: number;
        score?: number;
        sector?: string;
        regime?: string;
        factorBreakdown?: MarketFactorBreakdown;
        bulletins?: string[];
      }>;
    };
    if (!payload?.runId || !Array.isArray(payload.signals)) continue;
    const asOf = payload.asOf ?? event.createdAt;
    const asOfTime = new Date(asOf).getTime();
    const ageDays = Number.isFinite(asOfTime) ? (now - asOfTime) / 86_400_000 : undefined;
    if (typeof ageDays === "number" && ageDays > maxAgeDays) continue;

    for (const signal of payload.signals) {
      if (signal.chosen !== false || !signal.symbol || !positiveNumber(signal.refPrice)) continue;
      const symbol = normalizeSymbol(signal.symbol);
      if (seen.has(symbol)) continue;
      const currentPrice = positiveNumber(currentPrices[symbol]);
      if (!currentPrice) continue;
      seen.add(symbol);
      const refPrice = signal.refPrice as number;
      returns.push({
        runId: payload.runId,
        symbol,
        asOf,
        ...(typeof ageDays === "number" ? { ageDays: Number(ageDays.toFixed(1)) } : {}),
        refPrice,
        currentPrice,
        returnPct: Number((((currentPrice - refPrice) / refPrice) * 100).toFixed(2)),
        score: signal.score,
        sector: signal.sector,
        regime: signal.regime,
        dominantFactor: dominantFactor(signal.factorBreakdown),
        bulletins: signal.bulletins
      });
    }
  }

  return returns.sort((a, b) => b.returnPct - a.returnPct).slice(0, limit);
}

/**
 * Minimum closed lots before the auto-tuner is allowed to recommend factor-weight
 * shifts. Below this, suggestions are statistically untrustworthy and could overfit
 * a handful of trades (docs/phase-7-strategy.md §3.E guardrail).
 */
export const MIN_CLOSED_LOTS_FOR_WEIGHT_SHIFT = 20;

/**
 * Confidence calibration: realized win rate / avg return of closed BUY lots grouped by
 * the agent's entry `confidenceScore` band. Because confidence now drives position size,
 * this tells the agent whether its high-conviction calls actually win more than its
 * low-conviction ones (good calibration) or not (overconfidence) — so it can recalibrate.
 */
export interface ConfidenceCalibrationStat {
  band: string;
  trades: number;
  winRate: number;
  shrunkWinRate: number;
  avgReturnPct: number;
}

export function getConfidenceCalibration(
  accountNumber: string,
  source?: FillSource,
  currentPrices: Record<string, number> = {},
  userId: string = "local"
): ConfidenceCalibrationStat[] {
  const { closedLots } = calculatePnl(listFillEvents(accountNumber, source, 500, userId), currentPrices);
  const bandOf = (c: number): string => (c >= 85 ? "85-100 (high)" : c >= 70 ? "70-84" : c >= 50 ? "50-69" : "1-49 (low)");
  return aggregateClosedLots(
    closedLots.filter((lot) => lot.side === "long" && typeof lot.confidence === "number"),
    (lot) => bandOf(lot.confidence as number),
    userId
  )
    .map(({ key, trades, winRate, shrunkWinRate, avgReturnPct }) => ({ band: key, trades, winRate, shrunkWinRate, avgReturnPct }))
    .sort((a, b) => b.band.localeCompare(a.band));
}

/** Open (unclosed) lots with entry dates, for holding-period and tax analysis. */
export function getOpenLots(accountNumber: string, source?: FillSource, userId: string = "local"): OpenLot[] {
  return calculatePnl(listFillEvents(accountNumber, source, 500, userId)).openLots;
}

/**
 * Pseudo-count for Bayesian shrinkage of small-sample win rate / average return
 * toward a neutral prior (50% win, 0% return). With K=5, a single 100%-win trade
 * shrinks to ~58% rather than a misleading 100%, so the learning loop doesn't
 * overfit a handful of trades.
 */
const SHRINK_PRIOR = 5;

/** Shrinkage prior, overridable via policy.tuning.shrinkPrior (0 = no shrinkage); else the default. */
function resolveShrinkPrior(userId: string = "local"): number {
  try {
    const v = getPolicy(userId).tuning?.shrinkPrior;
    return typeof v === "number" && v >= 0 ? v : SHRINK_PRIOR;
  } catch {
    return SHRINK_PRIOR;
  }
}

function aggregateClosedLots(
  closedLots: ClosedLot[],
  keyFn: (lot: ClosedLot) => string,
  userId: string = "local"
): Array<{
  key: string;
  trades: number;
  winRate: number;
  avgReturnPct: number;
  totalPnl: number;
  shrunkWinRate: number;
  shrunkAvgReturnPct: number;
  /** Average calendar days held across closed lots in this bucket (undefined when no entryAt/exitAt data). */
  avgDaysHeld: number | undefined;
  /** Percentage of lots held < 365 days (short-term for tax purposes). */
  shortTermPct: number | undefined;
}> {
  const prior = resolveShrinkPrior(userId);
  const byKey = new Map<string, {
    pnl: number;
    returnSum: number;
    wins: number;
    trades: number;
    daysHeldSum: number;
    daysHeldCount: number;
    shortTermCount: number;
  }>();
  for (const lot of closedLots) {
    const key = keyFn(lot);
    const cur = byKey.get(key) ?? { pnl: 0, returnSum: 0, wins: 0, trades: 0, daysHeldSum: 0, daysHeldCount: 0, shortTermCount: 0 };
    cur.pnl += lot.pnl;
    cur.returnSum += lot.returnPct;
    cur.wins += lot.pnl > 0 ? 1 : 0;
    cur.trades += 1;
    // Holding-period derived fields (read-only; not used in any weight-nudge math).
    if (lot.entryAt && lot.exitAt) {
      const entryMs = new Date(lot.entryAt).getTime();
      const exitMs = new Date(lot.exitAt).getTime();
      if (Number.isFinite(entryMs) && Number.isFinite(exitMs) && exitMs >= entryMs) {
        const daysHeld = (exitMs - entryMs) / (1000 * 60 * 60 * 24);
        cur.daysHeldSum += daysHeld;
        cur.daysHeldCount += 1;
        if (daysHeld < 365) cur.shortTermCount += 1;
      }
    }
    byKey.set(key, cur);
  }
  return Array.from(byKey.entries())
    .map(([key, s]) => ({
      key,
      trades: s.trades,
      winRate: Math.round((s.wins / s.trades) * 100),
      avgReturnPct: Number((s.returnSum / s.trades).toFixed(2)),
      totalPnl: Number(s.pnl.toFixed(2)),
      // Shrink toward neutral (0.5 win, 0% return) with `prior` pseudo-trades.
      shrunkWinRate: Math.round(((s.wins + 0.5 * prior) / (s.trades + prior)) * 100),
      shrunkAvgReturnPct: Number((s.returnSum / (s.trades + prior)).toFixed(2)),
      // Holding-period fields: undefined when no lots in this bucket have entryAt/exitAt data.
      avgDaysHeld: s.daysHeldCount > 0 ? Number((s.daysHeldSum / s.daysHeldCount).toFixed(1)) : undefined,
      shortTermPct: s.daysHeldCount > 0 ? Number(((s.shortTermCount / s.daysHeldCount) * 100).toFixed(1)) : undefined
    }))
    .sort((a, b) => b.totalPnl - a.totalPnl);
}

function dominantFactor(breakdown?: MarketFactorBreakdown): MarketFactor | undefined {
  if (!breakdown) return undefined;
  let best: { factor: MarketFactor; value: number } | undefined;
  for (const [key, value] of Object.entries(breakdown)) {
    if (key === "weightedTotal") continue;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) continue;
    if (!best || numeric > best.value) best = { factor: key as MarketFactor, value: numeric };
  }
  return best?.factor;
}

function thesisMetaFromFill(fill: FillEvent): { thesisTag?: string; regime?: string; confidence?: number; sector?: string } {
  const raw = fill.raw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const proposal = r.proposal;
  const sector = typeof r.sector === "string" ? r.sector : undefined;
  if (!proposal || typeof proposal !== "object") return { sector };
  const p = proposal as Record<string, unknown>;
  return {
    thesisTag: typeof p.tradeThesisTag === "string" ? p.tradeThesisTag : undefined,
    regime: typeof p.entryMarketRegime === "string" ? p.entryMarketRegime : undefined,
    confidence: typeof p.confidenceScore === "number" ? p.confidenceScore : undefined,
    sector
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
