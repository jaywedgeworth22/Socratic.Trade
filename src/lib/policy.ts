import type { AccountCapabilities, EquityPosition, MarketScan, PolicyDecision, Portfolio, TradeProposal, TradingPolicy } from "./types";
import { normalizeSymbol } from "./money";
import { dynamicIndexUniversesForPolicy, symbolsForPolicyUniverse } from "./index-universes";
import { getUserWashSaleLockedSymbols } from "./tax";
import { getDb } from "./db";

export interface PolicyContext {
  policy: TradingPolicy;
  portfolio: Portfolio;
  positions: EquityPosition[];
  dailyNotionalUsed: number;
  /** Order notional already executed within the trailing 60 minutes (R1 hourly cap). */
  hourlyNotionalUsed?: number;
  /** Opening orders already placed today. Risk-reducing exits must not consume this cap. */
  dailyOrderCount: number;
  estimatedNotional?: number;
  marketScan?: MarketScan;
  /** Symbols closed at a loss within the last 30 days; buying them now would create a wash sale. */
  washSaleLockedSymbols?: Set<string>;
  /**
   * User identifier. Required for the wash-sale gate to resolve the cross-account locked set
   * when washSaleLockedSymbols is not pre-populated by the caller.
   */
  userId?: string;
  /** Capabilities of the connected account executing the order. When absent, all capabilities are treated as false (safe default). */
  accountCapabilities?: AccountCapabilities;
  /**
   * True only for real-capital brokerage (LIVE) execution. Test/local simulation and broker-Paper
   * accounts are NOT live and can never violate the Pattern-Day-Trader rule, so the PDT gate below
   * is skipped unless this is explicitly true. Absent/false ⇒ never PDT-gated (safe default).
   */
  isLiveExecution?: boolean;
  /**
   * Day-trades already executed on this account over the rolling 5-business-day PDT window
   * (FINRA Rule 4210). Computed by db.countDayTradesInLastBusinessDays and threaded in like the
   * other precomputed counts (dailyOrderCount/dailyNotionalUsed). Absent ⇒ treated as 0.
   */
  priorDayTradeCount?: number;
  now?: Date;
}

/**
 * Minimum equity a LIVE MARGIN account must hold before this app will submit opening margin trades.
 * FINRA Notice 26-10 replaces the old PDT count/$25k framework with intraday margin standards
 * effective 2026-06-04, but member firms may phase in implementation through 2027-10-20. This app
 * enforces the static margin minimum and defers broker-specific intraday margin restrictions to the
 * broker.
 */
export const MARGIN_MINIMUM_EQUITY = 2_000;
export const OPENING_ORDER_HEADROOM_PCT = 5;

function dollars(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function applyOpeningOrderHeadroom(value: number): number {
  if (!Number.isFinite(value)) return value;
  if (value <= 0) return 0;
  return Math.floor(value * (100 - OPENING_ORDER_HEADROOM_PCT)) / 100;
}

export function evaluateTradeProposal(proposal: TradeProposal, context: PolicyContext): PolicyDecision {
  const reasons: string[] = [];
  const symbol = normalizeSymbol(proposal.symbol);
  const estimatedNotional = context.estimatedNotional ?? estimateNotional(proposal);

  if (context.policy.systemState === "halted" && proposal.side !== "sell" && proposal.side !== "cover") {
    reasons.push("System is halted.");
  }
  if (context.policy.systemState === "liquidating" && proposal.side !== "sell" && proposal.side !== "cover") reasons.push("System is liquidating. Only close orders allowed.");
  if (context.policy.systemState === "close_only" && proposal.side !== "sell" && proposal.side !== "cover") reasons.push("System is close-only. New entries are disabled.");
  if (!context.policy.accountNumber) reasons.push("No Robinhood account is selected.");
  // Universe/blocklist applies to OPENING trades only. Never block a risk-reducing exit
  // (sell/cover) because the symbol was removed from the universe or blocklisted — that
  // would trap a position in a name you flagged precisely to get out of.
  const isOpening = proposal.side === "buy" || proposal.side === "short";
  if (isOpening) {
    const allowedSymbols = allowedSymbolsForPolicy(context.policy);
    const hasDynamicUniverse = dynamicIndexUniversesForPolicy(context.policy).length > 0;
    if (allowedSymbols.length === 0 && !hasDynamicUniverse) reasons.push("Allowed universe is required.");
    if (!allowedSymbols.includes(symbol) && !isDynamicScanSymbol(symbol, context)) reasons.push(`${symbol} is not in the allowed universe.`);
  }
  if (proposal.side !== "sell" && proposal.side !== "cover" && !context.policy.permittedOrderTypes.includes(proposal.type)) {
    reasons.push(`${proposal.type} orders are not permitted.`);
  }
  // Bracket orders: allow when "bracket" is in permittedOrderTypes OR when stop-loss rules are
  // configured (treating stop-loss rules as an implicit green-light for bracket risk management).
  // Permissive default — brackets should be encouraged when stop rules are active.
  if (proposal.bracketTakeProfit != null || proposal.bracketStopLoss != null) {
    const bracketPermitted =
      context.policy.permittedOrderTypes.includes("bracket" as any) ||
      (context.policy.riskRules?.stopLossPct != null && context.policy.riskRules.stopLossPct > 0);
    if (!bracketPermitted) {
      reasons.push('Bracket orders require "bracket" in permittedOrderTypes or a stopLossPct risk rule.');
    }
  }
  if (proposal.side !== "sell" && proposal.side !== "cover" && !context.policy.permitExtendedHours && proposal.marketHours !== "regular_hours") {
    reasons.push("Extended-hours orders are disabled.");
  }
  if ((proposal.dollarAmount || hasFractionalQuantity(proposal)) && proposal.marketHours !== "regular_hours") {
    reasons.push("Fractional or dollar-based orders must be regular-hours only.");
  }
  // Entry-drift guard: reject a stale OPENING market/dollar order whose price has moved away from
  // the proposed entry anchor (referencePrice) by more than maxEntryDriftPct. Limit orders are
  // excluded — the broker's limit already caps the fill. Fires only when both an entry anchor and a
  // fresh current price are known, so it can never false-reject on missing data. This closes the gap
  // where an hours-old market order approved off the run cadence (or with no LLM revalidation) still
  // executes at a materially worse price than the technical trigger that justified it.
  if (
    isOpening &&
    context.policy.maxEntryDriftPct != null &&
    context.policy.maxEntryDriftPct > 0 &&
    proposal.referencePrice != null &&
    proposal.referencePrice > 0 &&
    (proposal.type === "market" || proposal.dollarAmount != null || proposal.limitPrice == null)
  ) {
    const currentPrice = context.marketScan?.quotesBySymbol[symbol]?.price;
    if (currentPrice != null && currentPrice > 0) {
      const driftPct = (Math.abs(currentPrice - proposal.referencePrice) / proposal.referencePrice) * 100;
      if (driftPct > context.policy.maxEntryDriftPct) {
        reasons.push(
          `entry_drift: ${symbol} moved ${driftPct.toFixed(1)}% from the proposed entry $${proposal.referencePrice.toFixed(2)} ` +
            `(now $${currentPrice.toFixed(2)}), exceeding the ${context.policy.maxEntryDriftPct}% max entry drift.`
        );
      }
    }
  }
  // STALENESS GATE: block an OPENING proposal built on stale market data (fail-safe, DEFAULT OFF).
  // Enabled per-class only when the threshold is set (> 0). Fail-safe direction only: data older than
  // the threshold → block; a MISSING timestamp is treated as stale (block) ONLY because the gate is on.
  // Exits (sell/cover) are never gated. Timestamps are read from the run's MarketScan — never fabricated.
  if (isOpening) {
    const now = (context.now ?? new Date()).getTime();
    const maxQuoteAgeSec = context.policy.maxQuoteAgeSec;
    if (maxQuoteAgeSec != null && maxQuoteAgeSec > 0) {
      const quoteAsOf =
        context.marketScan?.quotesBySymbol[symbol]?.asOf ??
        context.marketScan?.topCandidates.find((c) => normalizeSymbol(c.symbol) === symbol)?.asOf;
      const asOfMs = quoteAsOf ? new Date(quoteAsOf).getTime() : NaN;
      if (!quoteAsOf || Number.isNaN(asOfMs)) {
        reasons.push(
          `staleness_gate: ${symbol} quote timestamp is missing/unparseable; treating as stale ` +
            `(maxQuoteAgeSec=${maxQuoteAgeSec}).`
        );
      } else {
        const ageSec = Math.round((now - asOfMs) / 1000);
        if (ageSec > maxQuoteAgeSec) {
          reasons.push(`staleness_gate: ${symbol} quote is ${ageSec}s old (max ${maxQuoteAgeSec}s).`);
        }
      }
    }
    const maxFundamentalsAgeSec = context.policy.maxFundamentalsAgeSec;
    if (maxFundamentalsAgeSec != null && maxFundamentalsAgeSec > 0) {
      const scanGeneratedAt = context.marketScan?.generatedAt;
      const genMs = scanGeneratedAt ? new Date(scanGeneratedAt).getTime() : NaN;
      if (!scanGeneratedAt || Number.isNaN(genMs)) {
        reasons.push(
          `staleness_gate: market-scan timestamp is missing/unparseable; treating fundamentals as stale ` +
            `(maxFundamentalsAgeSec=${maxFundamentalsAgeSec}).`
        );
      } else {
        const ageSec = Math.round((now - genMs) / 1000);
        if (ageSec > maxFundamentalsAgeSec) {
          reasons.push(`staleness_gate: market scan is ${ageSec}s old (max ${maxFundamentalsAgeSec}s).`);
        }
      }
    }
  }
  // SHORT_SELLING: opening shorts require both the policy flag and account capability.
  // Risk-reducing covers are allowed based on the existing short position even if shorting is now
  // disabled or capabilities are unavailable; blocking a cover would trap exposure.
  if (proposal.side === "short") {
    const brokerSupportsShort = context.accountCapabilities?.shortSelling === true;
    if (!context.policy.shortSellingEnabled || !brokerSupportsShort) {
      const why = !context.policy.shortSellingEnabled
        ? `short-selling is disabled in policy`
        : `the connected account does not support short selling`;
      reasons.push(`Order side "${proposal.side}" rejected: ${why}.`);
    } else {
      if (!context.policy.riskRules?.shortStopLossPct || context.policy.riskRules.shortStopLossPct <= 0) {
        reasons.push(`Short proposals must carry a mandatory stop-loss (policy.riskRules.shortStopLossPct).`);
      }
      if (context.policy.maxShortOrderNotional && estimatedNotional > context.policy.maxShortOrderNotional) {
        reasons.push(`Order of $${estimatedNotional.toFixed(2)} exceeds the max short order limit of $${context.policy.maxShortOrderNotional}`);
      }
    }
  }
  if (proposal.side === "cover" && coverQuantityExceedsShorts(proposal, context.positions)) {
    reasons.push(`Cover quantity exceeds current ${symbol} short holdings.`);
  }
  
  // MARGIN-ACCOUNT MINIMUM. FINRA Notice 26-10 replaces the old PDT count/$25k framework with
  // intraday margin standards effective 2026-06-04, with broker phase-in permitted through
  // 2027-10-20. We do not try to model broker-specific intraday margin; we enforce the static
  // $2,000 margin minimum on a LIVE/real-capital MARGIN account and defer the rest to the broker.
  // Scope: LIVE execution only (Test/local sim and broker-Paper are never gated); opening legs only;
  // cash (non-margin) accounts are never gated here (they aren't subject to the margin minimum).
  if (
    isOpening &&
    context.isLiveExecution === true &&
    context.accountCapabilities?.marginEnabled === true &&
    context.portfolio.totalMarketValue < MARGIN_MINIMUM_EQUITY
  ) {
    reasons.push(
      `margin_minimum: this LIVE margin account's equity $${context.portfolio.totalMarketValue.toFixed(2)} is below the ` +
        `$${MARGIN_MINIMUM_EQUITY.toLocaleString("en-US")} margin minimum. FINRA Notice 26-10 replaces the old PDT count/$25k framework, but broker phase-in and broker-specific intraday margin restrictions can still apply.`
    );
  }

  const effectiveMaxOrderNotional = Math.min(
    context.policy.maxOrderNotional ?? Infinity,
    context.policy.maxOrderPctOfNav ? (context.policy.maxOrderPctOfNav / 100) * context.portfolio.totalMarketValue : Infinity
  );
  if (isOpening && estimatedNotional > effectiveMaxOrderNotional) {
    reasons.push(`Order of $${estimatedNotional.toFixed(2)} exceeds the maximum order limit of $${effectiveMaxOrderNotional.toFixed(2)}`);
  }
  const headroomMaxOrderNotional = applyOpeningOrderHeadroom(effectiveMaxOrderNotional);
  if (
    isOpening &&
    Number.isFinite(effectiveMaxOrderNotional) &&
    Number.isFinite(headroomMaxOrderNotional) &&
    estimatedNotional > headroomMaxOrderNotional
  ) {
    reasons.push(
      `Order of ${dollars(estimatedNotional)} leaves less than ${OPENING_ORDER_HEADROOM_PCT}% buffer below the ${dollars(effectiveMaxOrderNotional)} maximum order limit; reduce to ${dollars(headroomMaxOrderNotional)} or raise the policy cap.`
    );
  }
  // Market-impact (ADV) ceiling: reject an opening order whose notional exceeds maxOrderPctOfAdv % of
  // the name's recent daily $-volume (price × volume from the scan; the app ingests no historical
  // bars). Defense-in-depth alongside deterministic sizing — also catches manual/non-sized proposals.
  // Skipped when the gauge is unavailable so it can never false-reject.
  if (isOpening && context.policy.maxOrderPctOfAdv != null && context.policy.maxOrderPctOfAdv > 0) {
    const full = context.marketScan?.topCandidates.find((c) => normalizeSymbol(c.symbol) === symbol);
    const dollarVol = full && full.price > 0 && full.volume > 0 ? full.price * full.volume : undefined;
    if (dollarVol != null) {
      const advCap = (context.policy.maxOrderPctOfAdv / 100) * dollarVol;
      if (estimatedNotional > advCap) {
        reasons.push(
          `Order of $${estimatedNotional.toFixed(2)} exceeds ${context.policy.maxOrderPctOfAdv}% of ${symbol}'s ~$${Math.round(dollarVol).toLocaleString("en-US")} daily $-volume (ADV cap $${advCap.toFixed(2)}) — would risk outsized market impact.`
        );
      }
    }
  }
  const effectiveMaxDailyNotional = Math.min(
    context.policy.maxDailyNotional ?? Infinity,
    context.policy.maxDailyPctOfNav ? (context.policy.maxDailyPctOfNav / 100) * context.portfolio.totalMarketValue : Infinity
  );
  if (isOpening && context.dailyNotionalUsed + estimatedNotional > effectiveMaxDailyNotional) {
    reasons.push("Daily notional limit would be exceeded.");
  }
  if (
    isOpening &&
    context.policy.maxHourlyNotional != null &&
    (context.hourlyNotionalUsed ?? 0) + estimatedNotional > context.policy.maxHourlyNotional
  ) {
    reasons.push("Hourly notional limit would be exceeded.");
  }
  if (isOpening && context.dailyOrderCount + 1 > context.policy.maxDailyOrders) {
    reasons.push("Daily opening-order count limit would be exceeded.");
  }
  // Affordability: block an opening order the account can't fund rather than outsourcing the
  // check to the broker's margin rejection. buyingPower is broker-accurate for live/paper
  // (margin-aware) and cash for Test; a non-positive/non-finite value (a gateway that doesn't
  // report it) is treated as "unknown" and never blocks, so this can't false-positive.
  if (
    isOpening &&
    Number.isFinite(context.portfolio.buyingPower) &&
    context.portfolio.buyingPower > 0 &&
    estimatedNotional > context.portfolio.buyingPower
  ) {
    reasons.push(`Order of $${estimatedNotional.toFixed(2)} exceeds available buying power $${context.portfolio.buyingPower.toFixed(2)}.`);
  }
  if (proposal.side === "sell" && sellQuantityExceedsHoldings(proposal, context.positions)) {
    reasons.push(`Sell quantity exceeds current ${symbol} holdings.`);
  }

  // An exit (sell/cover) must carry a resolvable size. A size-less exit (neither quantity nor
  // dollarAmount) slips past the holdings/notional checks above (they no-op on an undefined
  // quantity) and books a ZERO-quantity phantom fill the dashboard reports as a successful close
  // while the position stays fully open and exposed. Deterministic sizing resolves LLM-emitted
  // exits to the full position before they reach here, so a size-less exit at the gate is a real
  // defect — reject it rather than silently no-op the stop.
  if (
    (proposal.side === "sell" || proposal.side === "cover") &&
    proposal.quantity == null &&
    proposal.dollarAmount == null
  ) {
    reasons.push(`${symbol} exit must specify a quantity or dollar amount.`);
  }

  const crisisOpeningExposureReason = deRiskInCrisisReason(proposal, context, estimatedNotional);
  if (crisisOpeningExposureReason) reasons.push(crisisOpeningExposureReason);

  // Wash-sale guardrail (IRC §1091): don't rebuy a symbol closed at a loss within
  // the last 30 days, which would disallow the loss. Configurable via taxSettings.
  // Wash sales are only relevant for BUY orders (re-establishing a long position).
  // Covers are buy-to-close on a short and do NOT re-establish the sold long position,
  // so they are intentionally excluded here.
  //
  // Authoritative cross-account enforcement (architecture-blueprint §3.3): if the
  // caller did not pre-populate washSaleLockedSymbols, resolve it now using
  // getUserWashSaleLockedSymbols so the gate cannot be silently bypassed by a caller
  // that omits the locked set.
  if (
    proposal.side === "buy" &&
    (context.policy.taxSettings?.washSaleGuard ?? true)
  ) {
    const lockedSymbols: Set<string> =
      context.washSaleLockedSymbols ??
      (context.userId != null ? getUserWashSaleLockedSymbols(context.userId, context.now ?? new Date()) : new Set<string>());
    if (lockedSymbols.has(symbol)) {
      reasons.push(`${symbol} is in a 30-day wash-sale lockout (a position was closed at a loss within the last 30 days); rebuying now would disallow that loss.`);
    }
  }

  if (isOpening && proposal.side === "short" && context.policy.maxShortExposurePct) {
    const totalShortExposure = context.positions.reduce((sum, pos) => pos.quantity < 0 ? sum + Math.abs(pos.marketValue) : sum, 0);
    const projectedShortExposure = totalShortExposure + estimatedNotional;
    const projectedShortExposurePct = context.portfolio.totalMarketValue > 0 ? (projectedShortExposure / context.portfolio.totalMarketValue) * 100 : 0;
    if (projectedShortExposurePct > context.policy.maxShortExposurePct) {
      reasons.push(`Projected total short exposure ${projectedShortExposurePct.toFixed(2)}% exceeds maxShortExposurePct limit of ${context.policy.maxShortExposurePct}%.`);
    }
  }

  // Per-symbol exposure % cap — OPENING orders only. A close (sell/cover) can only reduce a symbol's
  // exposure, so it must never be blocked here (otherwise the very risk-exit triggered by an over-cap
  // position — see strategy.ts "SELL/TRIM any position exceeding maxSymbolExposurePct%" — would be
  // blocked by the same cap that demanded it). Mirrors the isOpening gate on maxSymbolExposureNotional
  // below. This cap is ON by default (unlike the 100% gross/net defaults).
  const projectedSymbolExposurePct = projectedExposurePct(proposal, context.positions, context.portfolio, estimatedNotional);
  if (isOpening && context.policy.maxSymbolExposurePct && projectedSymbolExposurePct > context.policy.maxSymbolExposurePct) {
    reasons.push(`Projected ${symbol} exposure ${projectedSymbolExposurePct.toFixed(2)}% exceeds ${context.policy.maxSymbolExposurePct}%.`);
  }
  if (context.policy.maxSymbolExposureNotional && isOpening) {
    const existingPosition = context.positions.find((p) => normalizeSymbol(p.symbol) === normalizeSymbol(proposal.symbol));
    const existingValue = existingPosition ? Math.abs(existingPosition.marketValue) : 0;
    // Opening orders (buy/short) ADD exposure. Closing orders (sell/cover) always
    // reduce symbol exposure and must never be blocked — guard on isOpening above.
    const projectedNotional = existingValue + estimatedNotional;
    if (projectedNotional > context.policy.maxSymbolExposureNotional) {
      reasons.push(`Projected ${symbol} notional exposure $${projectedNotional.toFixed(2)} exceeds cap $${context.policy.maxSymbolExposureNotional.toFixed(2)}.`);
    }
  }

  // Whole-portfolio gross/net exposure caps. Gross = Σ|marketValue| (total market
  // involvement / leverage); net = Σ marketValue (directional bias). These apply to OPENING
  // orders only — a risk-reducing close (sell/cover) is ALWAYS allowed, since it can only move
  // gross/net toward zero. We gate on `isOpening` rather than relying solely on the
  // "further-from-cap" guards because a corrupt/oversized notional on a close (e.g. an exit with
  // no live quote) can overshoot through zero and look like a huge opposite-side position, which
  // previously blocked the exit. These mainly bite once short selling is enabled (default 100%).
  if ((context.policy.maxGrossExposurePct || context.policy.maxNetExposurePct) && isOpening) {
    const totalValue = context.portfolio.totalMarketValue;
    if (totalValue > 0) {
      const grossNow = context.positions.reduce((sum, p) => sum + Math.abs(p.marketValue), 0);
      const netNow = context.positions.reduce((sum, p) => sum + p.marketValue, 0);
      const grossProjected = grossNow + estimatedNotional;
      const netDelta = proposal.side === "buy" ? estimatedNotional : -estimatedNotional; // opening: buy=long, short=short
      const netProjected = netNow + netDelta;
      if (context.policy.maxGrossExposurePct) {
        const grossCap = (context.policy.maxGrossExposurePct / 100) * totalValue;
        if (grossProjected > grossCap && grossProjected > grossNow) {
          reasons.push(`Projected gross exposure $${grossProjected.toFixed(2)} exceeds gross cap $${grossCap.toFixed(2)} (${context.policy.maxGrossExposurePct}%).`);
        }
      }
      if (context.policy.maxNetExposurePct) {
        const netCap = (context.policy.maxNetExposurePct / 100) * totalValue;
        if (Math.abs(netProjected) > netCap && Math.abs(netProjected) > Math.abs(netNow)) {
          reasons.push(`Projected net exposure $${netProjected.toFixed(2)} exceeds net cap $${netCap.toFixed(2)} (${context.policy.maxNetExposurePct}%).`);
        }
      }
    }
  }

  // Sector exposure % cap — OPENING orders only, same reasoning as the per-symbol cap: a close can only
  // reduce sector exposure, so it must never be blocked (a stale/zero notional on an exit would otherwise
  // make projected == current and re-block a name in an already-over-cap sector).
  const sectorDecision = isOpening ? projectedSectorExposurePct(proposal, context, estimatedNotional) : null;
  if (sectorDecision && sectorDecision.cap > 0 && sectorDecision.projectedPct > sectorDecision.cap) {
    reasons.push(`Projected ${sectorDecision.sector} sector exposure ${sectorDecision.projectedPct.toFixed(2)}% exceeds sector cap ${sectorDecision.cap}%.`);
  }

  // Portfolio beta cap. Bounds aggregate market-directional exposure: Σ(signedMarketValue·beta) ÷
  // totalEquity, including the candidate. The per-symbol/sector caps don't see correlation, so a
  // cluster of individually-approved high-beta names can still build a large correlated drawdown;
  // this catches that. A long buy adds +beta exposure, a short adds -beta. Per-name beta comes from
  // the scan (names without a beta count as 1.0). Only an OPENING order that pushes |projected beta|
  // BOTH past the cap AND further from the current level is blocked — a beta-reducing trade always
  // passes. Defaults off (undefined); especially relevant once shorting is enabled.
  if (isOpening && context.policy.maxPortfolioBeta != null && context.policy.maxPortfolioBeta > 0) {
    const totalEquity = context.portfolio.totalMarketValue;
    if (totalEquity > 0) {
      const betaFor = (sym: string): number => {
        const b = context.marketScan?.quotesBySymbol[normalizeSymbol(sym)]?.beta;
        return b != null && Number.isFinite(b) ? b : 1;
      };
      const netBetaNow = context.positions.reduce((sum, p) => sum + p.marketValue * betaFor(p.symbol), 0);
      const signedDelta = proposal.side === "short" ? -estimatedNotional : estimatedNotional;
      const netBetaProjected = netBetaNow + signedDelta * betaFor(proposal.symbol);
      const projectedPortfolioBeta = netBetaProjected / totalEquity;
      const currentPortfolioBeta = netBetaNow / totalEquity;
      if (
        Math.abs(projectedPortfolioBeta) > context.policy.maxPortfolioBeta &&
        Math.abs(projectedPortfolioBeta) > Math.abs(currentPortfolioBeta)
      ) {
        reasons.push(
          `Projected portfolio beta ${projectedPortfolioBeta.toFixed(2)} exceeds the maxPortfolioBeta cap ` +
            `of ${context.policy.maxPortfolioBeta} (current ${currentPortfolioBeta.toFixed(2)}).`
        );
      }
    }
  }

  const riskReason = riskRuleReason(proposal, context);
  if (riskReason) reasons.push(riskReason);

  return {
    approved: reasons.length === 0,
    reasons,
    projectedSymbolExposurePct,
    // Opening sides accumulate daily notional; closing sides (sell/cover) do not (matches the
    // daily/hourly cap checks above, which are gated on isOpening). (T14)
    dailyNotionalUsed: context.dailyNotionalUsed + (isOpening ? estimatedNotional : 0)
  };
}

export function allowedSymbolsForPolicy(policy: TradingPolicy): string[] {
  return symbolsForPolicyUniverse(policy);
}

function isDynamicScanSymbol(symbol: string, context: PolicyContext): boolean {
  if (dynamicIndexUniversesForPolicy(context.policy).length === 0) return false;
  const quote = context.marketScan?.quotesBySymbol[symbol];
  return typeof quote?.score === "number" && quote.score > 0;
}

export function estimateNotional(proposal: TradeProposal): number {
  if (proposal.dollarAmount) return proposal.dollarAmount;
  const price = proposal.limitPrice ?? proposal.stopPrice ?? 0;
  return (proposal.quantity ?? 0) * price;
}

function hasFractionalQuantity(proposal: TradeProposal): boolean {
  return proposal.quantity !== undefined && !Number.isInteger(proposal.quantity);
}

function sellQuantityExceedsHoldings(proposal: TradeProposal, positions: EquityPosition[]): boolean {
  if (proposal.side !== "sell" || proposal.quantity === undefined) return false;
  const position = positions.find((item) => normalizeSymbol(item.symbol) === normalizeSymbol(proposal.symbol));
  const currentQty = position?.quantity ?? 0;
  if (currentQty <= 0) return true; // Cannot sell if flat or short
  return currentQty < proposal.quantity;
}

function coverQuantityExceedsShorts(proposal: TradeProposal, positions: EquityPosition[]): boolean {
  if (proposal.side !== "cover" || proposal.quantity === undefined) return false;
  const position = positions.find((item) => normalizeSymbol(item.symbol) === normalizeSymbol(proposal.symbol));
  const currentQty = position?.quantity ?? 0;
  if (currentQty >= 0) return true; // Cannot cover if flat or long
  return Math.abs(currentQty) < proposal.quantity;
}

function deRiskInCrisisReason(
  proposal: TradeProposal,
  context: PolicyContext,
  estimatedNotional: number
): string | undefined {
  const isOpening = proposal.side === "buy" || proposal.side === "short";
  if (!isOpening) return undefined;

  const cap = context.policy.tuning?.crisisMaxOpeningExposurePct;
  if (cap === undefined || cap <= 0 || !Number.isFinite(cap)) return undefined;
  if (!isCrisisOrInvertedRegime(proposal.entryMarketRegime)) return undefined;
  if (context.portfolio.totalMarketValue <= 0) return undefined;

  const openingExposurePct = (estimatedNotional / context.portfolio.totalMarketValue) * 100;
  if (openingExposurePct <= cap) return undefined;

  return `Opening ${normalizeSymbol(proposal.symbol)} exposure ${openingExposurePct.toFixed(2)}% exceeds crisis/inverted-regime cap ${cap}%.`;
}

function isCrisisOrInvertedRegime(regime?: string): boolean {
  const normalized = regime?.toLowerCase() ?? "";
  return normalized.includes("crisis") || normalized.includes("inverted");
}

function projectedExposurePct(
  proposal: TradeProposal,
  positions: EquityPosition[],
  portfolio: Portfolio,
  notional: number
): number {
  const symbol = normalizeSymbol(proposal.symbol);
  const position = positions.find((item) => normalizeSymbol(item.symbol) === symbol);
  const current = Math.abs(position?.marketValue ?? 0);
  const isOpening = proposal.side === "buy" || proposal.side === "short";
  const projected = isOpening ? current + notional : Math.max(0, current - notional);
  if (portfolio.totalMarketValue <= 0) return Infinity;
  return (projected / portfolio.totalMarketValue) * 100;
}

function projectedSectorExposurePct(
  proposal: TradeProposal,
  context: PolicyContext,
  notional: number
): { sector: string; projectedPct: number; cap: number } | undefined {
  const symbol = normalizeSymbol(proposal.symbol);
  const sector = sectorForSymbol(symbol, context.positions, context.marketScan);
  if (!sector) return undefined;
  const cap = sectorCapFor(context.policy, sector);
  if (cap === undefined) return undefined;

  const currentValue = context.positions
    .filter((position) => sectorForSymbol(normalizeSymbol(position.symbol), context.positions, context.marketScan) === sector)
    .reduce((sum, position) => sum + Math.abs(position.marketValue), 0);
  
  const isOpening = proposal.side === "buy" || proposal.side === "short";
  const isClosing = proposal.side === "sell" || proposal.side === "cover";
  const projectedValue = isOpening ? currentValue + notional : (isClosing ? Math.max(0, currentValue - notional) : currentValue);
  const projectedPct = context.portfolio.totalMarketValue > 0 ? (projectedValue / context.portfolio.totalMarketValue) * 100 : 0;
  return { sector, projectedPct, cap };
}

function riskRuleReason(proposal: TradeProposal, context: PolicyContext): string | undefined {
  const position = context.positions.find((item) => normalizeSymbol(item.symbol) === normalizeSymbol(proposal.symbol));
  if (!position || position.averageCost <= 0) return undefined;

  // Optional volatility-aware stop scaling: widen the stop for high-beta names, tighten for low-beta.
  const beta = context.marketScan?.quotesBySymbol[normalizeSymbol(proposal.symbol)]?.beta;
  const betaStops = context.policy.betaScaledStops === true;

  if (proposal.side === "buy") {
    if (position.quantity > 0) {
      const avgCost = position.averageCost;
      const currentPrice = proposal.limitPrice ?? proposal.stopPrice ?? avgCost;
      const drawdownPct = ((avgCost - currentPrice) / avgCost) * 100;
      const returnPct = ((currentPrice - avgCost) / avgCost) * 100;

      const effStopLossPct = betaScaledStopPct(context.policy.riskRules?.stopLossPct ?? 0, beta, betaStops);
      if (effStopLossPct > 0 && drawdownPct > effStopLossPct) {
        return `Stop-loss rule blocks adding to ${normalizeSymbol(proposal.symbol)} while it is down ${drawdownPct.toFixed(2)}%.`;
      }
      if (context.policy.riskRules?.stopLossNotional) {
        const totalDrawdownNotional = (avgCost - currentPrice) * position.quantity;
        if (totalDrawdownNotional > context.policy.riskRules.stopLossNotional) {
          return `Stop-loss rule blocks adding to ${normalizeSymbol(proposal.symbol)} while it is down $${totalDrawdownNotional.toFixed(2)}.`;
        }
      }
      if (context.policy.riskRules?.takeProfitPct && returnPct >= context.policy.riskRules.takeProfitPct) {
        return `Take-profit rule blocks adding to ${normalizeSymbol(proposal.symbol)} while it is up ${returnPct.toFixed(2)}%.`;
      }
      if (context.policy.riskRules?.takeProfitNotional) {
        const totalReturnNotional = (currentPrice - avgCost) * position.quantity;
        if (totalReturnNotional >= context.policy.riskRules.takeProfitNotional) {
          return `Take-profit rule blocks adding to ${normalizeSymbol(proposal.symbol)} while it is up $${totalReturnNotional.toFixed(2)}.`;
        }
      }
    }
  } else if (proposal.side === "short") {
    if (position.quantity < 0) {
      const avgCost = position.averageCost;
      const currentPrice = proposal.limitPrice ?? proposal.stopPrice ?? avgCost;
      const drawdownPct = ((currentPrice - avgCost) / avgCost) * 100; // Inverse math for short: price up means loss

      const effShortStopPct = betaScaledStopPct(context.policy.riskRules?.shortStopLossPct ?? 0, beta, betaStops);
      if (effShortStopPct > 0 && drawdownPct > effShortStopPct) {
        return `Cannot average up on short: Position is down ${drawdownPct.toFixed(2)}%, exceeding short stop-loss limit of ${context.policy.riskRules.shortStopLossPct}%.`;
      }
    }
  }
  return undefined;
}

function sectorForSymbol(symbol: string, positions: EquityPosition[], marketScan?: MarketScan): string | undefined {
  const positionSector = positions.find((position) => normalizeSymbol(position.symbol) === symbol)?.sector;
  if (positionSector) return positionSector;

  if (marketScan) {
    const scanSector = marketScan.sectorBySymbol[symbol] ?? marketScan.quotesBySymbol[symbol]?.sector;
    if (scanSector) return scanSector;
  }

  // Fallback: query the local SQLite imported_securities_ref table
  try {
    const row = getDb()
      .prepare("SELECT sector FROM imported_securities_ref WHERE ticker = ?")
      .get(symbol) as { sector: string | null } | undefined;
    if (row?.sector) return row.sector;
  } catch {
    // DB query error or database not initialized (e.g. during tests)
  }

  return undefined;
}

function sectorCapFor(policy: TradingPolicy, sector: string): number | undefined {
  const exact = policy.sectorCaps[sector];
  if (exact !== undefined) return exact;
  const match = Object.entries(policy.sectorCaps).find(([key]) => key.toLowerCase() === sector.toLowerCase());
  return match?.[1];
}

/**
 * Volatility-aware stop scaling. Widens the stop distance for high-beta names (fewer noise
 * stop-outs) and tightens it for low-beta names (cut losers sooner), instead of one flat % for
 * every ticker. Beta is clamped to [0.5×, 2.0×] so a missing/extreme value can't produce an absurd
 * stop. Returns the base unchanged when scaling is disabled or beta is unavailable/invalid — so this
 * is always safe to call. Shared by the gate (riskRuleReason), the proactive risk-exit generator,
 * and the synthetic trailing stop so all three stay consistent.
 */
export function betaScaledStopPct(baseStopPct: number, beta: number | undefined, enabled: boolean): number {
  if (!enabled || baseStopPct <= 0 || beta == null || !Number.isFinite(beta) || beta <= 0) return baseStopPct;
  const clamped = Math.max(0.5, Math.min(2.0, beta));
  return baseStopPct * clamped;
}
