import type { EquityPosition, MarketScan, PolicyDecision, Portfolio, TradeProposal, TradingPolicy } from "./types";
import { normalizeSymbol } from "./money";
import { SP500_SYMBOLS } from "./sp500";

export interface PolicyContext {
  policy: TradingPolicy;
  portfolio: Portfolio;
  positions: EquityPosition[];
  dailyNotionalUsed: number;
  dailyOrderCount: number;
  estimatedNotional?: number;
  marketScan?: MarketScan;
  /** Symbols closed at a loss within the last 30 days; buying them now would create a wash sale. */
  washSaleLockedSymbols?: Set<string>;
  now?: Date;
}

export function evaluateTradeProposal(proposal: TradeProposal, context: PolicyContext): PolicyDecision {
  const reasons: string[] = [];
  const symbol = normalizeSymbol(proposal.symbol);
  const estimatedNotional = context.estimatedNotional ?? estimateNotional(proposal);

  if (context.policy.systemState === "halted") reasons.push("System is halted.");
  if (context.policy.systemState === "liquidating" && proposal.side !== "sell" && proposal.side !== "cover") reasons.push("System is liquidating. Only close orders allowed.");
  if (context.policy.systemState === "close_only" && proposal.side !== "sell" && proposal.side !== "cover") reasons.push("System is close-only. New entries are disabled.");
  if (!context.policy.accountNumber) reasons.push("No Robinhood account is selected.");
  const allowedSymbols = allowedSymbolsForPolicy(context.policy);
  if (allowedSymbols.length === 0) reasons.push("Symbol allowlist is required.");
  if (!allowedSymbols.includes(symbol)) reasons.push(`${symbol} is not in the allowed universe.`);
  if (!context.policy.permittedOrderTypes.includes(proposal.type)) reasons.push(`${proposal.type} orders are not permitted.`);
  if (!context.policy.permitExtendedHours && proposal.marketHours !== "regular_hours") {
    reasons.push("Extended-hours orders are disabled.");
  }
  if ((proposal.dollarAmount || hasFractionalQuantity(proposal)) && proposal.marketHours !== "regular_hours") {
    reasons.push("Fractional or dollar-based orders must be regular-hours only.");
  }
  // SHORT_SELLING: Feature gate. When shortSellingEnabled is true, short/cover
  // proposals pass through to the guardrails below. When false (default), they
  // are unconditionally rejected. Flip this flag + implement the SHORT_SELLING
  // TODOs below + confirm broker support before enabling.
  if (proposal.side !== "buy" && proposal.side !== "sell") {
    if (!context.policy.shortSellingEnabled) {
      reasons.push(`Order side "${proposal.side}" is not supported. Only "buy" and "sell" are permitted.`);
    } else {
      if (proposal.side === "short") {
        if (!context.policy.riskRules?.shortStopLossPct || context.policy.riskRules.shortStopLossPct <= 0) {
          reasons.push(`Short proposals must carry a mandatory stop-loss (policy.riskRules.shortStopLossPct).`);
        }
        if (context.policy.maxShortOrderNotional && estimatedNotional > context.policy.maxShortOrderNotional) {
          reasons.push(`Order of $${estimatedNotional.toFixed(2)} exceeds the max short order limit of $${context.policy.maxShortOrderNotional}`);
        }
      }
      if (proposal.side === "cover" && coverQuantityExceedsShorts(proposal, context.positions)) {
        reasons.push(`Cover quantity exceeds current ${symbol} short holdings.`);
      }
    }
  }
  
  const isOpening = proposal.side === "buy" || proposal.side === "short";
  const effectiveMaxOrderNotional = Math.min(
    context.policy.maxOrderNotional ?? Infinity,
    context.policy.maxOrderPctOfNav ? (context.policy.maxOrderPctOfNav / 100) * context.portfolio.totalMarketValue : Infinity
  );
  if (isOpening && estimatedNotional > effectiveMaxOrderNotional) {
    reasons.push(`Order of $${estimatedNotional.toFixed(2)} exceeds the maximum order limit of $${effectiveMaxOrderNotional.toFixed(2)}`);
  }
  const effectiveMaxDailyNotional = Math.min(
    context.policy.maxDailyNotional ?? Infinity,
    context.policy.maxDailyPctOfNav ? (context.policy.maxDailyPctOfNav / 100) * context.portfolio.totalMarketValue : Infinity
  );
  if (isOpening && context.dailyNotionalUsed + estimatedNotional > effectiveMaxDailyNotional) {
    reasons.push("Daily notional limit would be exceeded.");
  }
  if (context.dailyOrderCount + 1 > context.policy.maxDailyOrders) {
    reasons.push("Daily order count limit would be exceeded.");
  }
  if (proposal.side === "sell" && sellQuantityExceedsHoldings(proposal, context.positions)) {
    reasons.push(`Sell quantity exceeds current ${symbol} holdings.`);
  }

  const crisisOpeningExposureReason = deRiskInCrisisReason(proposal, context, estimatedNotional);
  if (crisisOpeningExposureReason) reasons.push(crisisOpeningExposureReason);

  // Wash-sale guardrail (IRC §1091): don't rebuy a symbol closed at a loss within
  // the last 30 days, which would disallow the loss. Configurable via taxSettings.
  if (
    proposal.side === "buy" &&
    (context.policy.taxSettings?.washSaleGuard ?? true) &&
    context.washSaleLockedSymbols?.has(symbol)
  ) {
    reasons.push(`${symbol} is in a 30-day wash-sale lockout (a position was closed at a loss within the last 30 days); rebuying now would disallow that loss.`);
  }

  if (isOpening && proposal.side === "short" && context.policy.maxShortExposurePct) {
    const totalShortExposure = context.positions.reduce((sum, pos) => pos.quantity < 0 ? sum + Math.abs(pos.marketValue) : sum, 0);
    const projectedShortExposure = totalShortExposure + estimatedNotional;
    const projectedShortExposurePct = context.portfolio.totalMarketValue > 0 ? (projectedShortExposure / context.portfolio.totalMarketValue) * 100 : 0;
    if (projectedShortExposurePct > context.policy.maxShortExposurePct) {
      reasons.push(`Projected total short exposure ${projectedShortExposurePct.toFixed(2)}% exceeds maxShortExposurePct limit of ${context.policy.maxShortExposurePct}%.`);
    }
  }

  const projectedSymbolExposurePct = projectedExposurePct(proposal, context.positions, context.portfolio, estimatedNotional);
  if (context.policy.maxSymbolExposurePct && projectedSymbolExposurePct > context.policy.maxSymbolExposurePct) {
    reasons.push(`Projected ${symbol} exposure ${projectedSymbolExposurePct.toFixed(2)}% exceeds ${context.policy.maxSymbolExposurePct}%.`);
  }
  if (context.policy.maxSymbolExposureNotional) {
    const existingPosition = context.positions.find((p) => normalizeSymbol(p.symbol) === normalizeSymbol(proposal.symbol));
    const existingValue = existingPosition ? Math.abs(existingPosition.marketValue) : 0;
    const projectedNotional = existingValue + estimatedNotional;
    if (projectedNotional > context.policy.maxSymbolExposureNotional) {
      reasons.push(`Projected ${symbol} notional exposure $${projectedNotional.toFixed(2)} exceeds cap $${context.policy.maxSymbolExposureNotional.toFixed(2)}.`);
    }
  }

  const sectorDecision = projectedSectorExposurePct(proposal, context, estimatedNotional);
  if (sectorDecision && sectorDecision.cap > 0 && sectorDecision.projectedPct > sectorDecision.cap) {
    reasons.push(`Projected ${sectorDecision.sector} sector exposure ${sectorDecision.projectedPct.toFixed(2)}% exceeds sector cap ${sectorDecision.cap}%.`);
  }

  const riskReason = riskRuleReason(proposal, context);
  if (riskReason) reasons.push(riskReason);

  return {
    approved: reasons.length === 0,
    reasons,
    projectedSymbolExposurePct,
    dailyNotionalUsed: context.dailyNotionalUsed + estimatedNotional
  };
}

export function allowedSymbolsForPolicy(policy: TradingPolicy): string[] {
  let symbols = new Set<string>();
  const indices = policy.includedIndices || [];
  if (indices.includes("sp500")) SP500_SYMBOLS.forEach(s => symbols.add(s));
  
  const additional = policy.additionalSymbols || [];
  additional.forEach(s => symbols.add(normalizeSymbol(s)));
  
  if (policy.blocklist) {
    policy.blocklist.forEach(s => symbols.delete(normalizeSymbol(s)));
  }
  
  return Array.from(symbols);
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
  if (portfolio.totalMarketValue <= 0) return 0;
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

  if (proposal.side === "buy") {
    if (position.quantity > 0) {
      const avgCost = position.averageCost;
      const currentPrice = proposal.limitPrice ?? proposal.stopPrice ?? avgCost;
      const drawdownPct = ((avgCost - currentPrice) / avgCost) * 100;
      const returnPct = ((currentPrice - avgCost) / avgCost) * 100;
      
      if (context.policy.riskRules?.stopLossPct && drawdownPct > context.policy.riskRules.stopLossPct) {
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
      
      if (context.policy.riskRules?.shortStopLossPct && drawdownPct > context.policy.riskRules.shortStopLossPct) {
        return `Cannot average up on short: Position is down ${drawdownPct.toFixed(2)}%, exceeding short stop-loss limit of ${context.policy.riskRules.shortStopLossPct}%.`;
      }
    }
  }
  return undefined;
}

function sectorForSymbol(symbol: string, positions: EquityPosition[], marketScan?: MarketScan): string | undefined {
  return (
    positions.find((position) => normalizeSymbol(position.symbol) === symbol)?.sector ??
    marketScan?.sectorBySymbol[symbol] ??
    marketScan?.quotesBySymbol[symbol]?.sector
  );
}

function sectorCapFor(policy: TradingPolicy, sector: string): number | undefined {
  const exact = policy.sectorCaps[sector];
  if (exact !== undefined) return exact;
  const match = Object.entries(policy.sectorCaps).find(([key]) => key.toLowerCase() === sector.toLowerCase());
  return match?.[1];
}

function currentPriceForPosition(position: EquityPosition, marketScan?: MarketScan): number | undefined {
  const symbol = normalizeSymbol(position.symbol);
  const scanPrice = marketScan?.quotesBySymbol[symbol]?.price;
  if (scanPrice && scanPrice > 0) return scanPrice;
  if (position.quantity > 0) return position.marketValue / position.quantity;
  return undefined;
}
