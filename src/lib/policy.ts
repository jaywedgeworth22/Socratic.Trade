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
  now?: Date;
}

export function evaluateTradeProposal(proposal: TradeProposal, context: PolicyContext): PolicyDecision {
  const reasons: string[] = [];
  const symbol = normalizeSymbol(proposal.symbol);
  const estimatedNotional = context.estimatedNotional ?? estimateNotional(proposal);

  if (!context.policy.enabled) reasons.push("Autonomy is disabled.");
  if (context.policy.killSwitch) reasons.push("Kill switch is active.");
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
  if (estimatedNotional > context.policy.maxOrderNotional) {
    reasons.push(`Order notional ${estimatedNotional.toFixed(2)} exceeds max order notional ${context.policy.maxOrderNotional.toFixed(2)}.`);
  }
  if (context.dailyNotionalUsed + estimatedNotional > context.policy.maxDailyNotional) {
    reasons.push("Daily notional limit would be exceeded.");
  }
  if (context.dailyOrderCount + 1 > context.policy.maxDailyOrders) {
    reasons.push("Daily order count limit would be exceeded.");
  }
  if (proposal.side === "sell" && sellQuantityExceedsHoldings(proposal, context.positions)) {
    reasons.push(`Sell quantity exceeds current ${symbol} holdings.`);
  }

  const projectedSymbolExposurePct = projectedExposurePct(proposal, context.positions, context.portfolio, estimatedNotional);
  if (projectedSymbolExposurePct > context.policy.maxSymbolExposurePct) {
    reasons.push(`Projected ${symbol} exposure ${projectedSymbolExposurePct.toFixed(2)}% exceeds ${context.policy.maxSymbolExposurePct}%.`);
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
  if (policy.universe === "sp500") return [...SP500_SYMBOLS];
  return policy.allowlist.map(normalizeSymbol);
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
  return (position?.quantity ?? 0) < proposal.quantity;
}

function projectedExposurePct(
  proposal: TradeProposal,
  positions: EquityPosition[],
  portfolio: Portfolio,
  notional: number
): number {
  const symbol = normalizeSymbol(proposal.symbol);
  const current = positions.find((item) => normalizeSymbol(item.symbol) === symbol)?.marketValue ?? 0;
  const projected = proposal.side === "buy" ? current + notional : Math.max(0, current - notional);
  if (portfolio.totalMarketValue <= 0) return 0;
  return (projected / portfolio.totalMarketValue) * 100;
}

function projectedSectorExposurePct(
  proposal: TradeProposal,
  context: PolicyContext,
  notional: number
): { sector: string; projectedPct: number; cap: number } | undefined {
  if (proposal.side !== "buy" && proposal.side !== "sell") return undefined;
  const symbol = normalizeSymbol(proposal.symbol);
  const sector = sectorForSymbol(symbol, context.positions, context.marketScan);
  if (!sector) return undefined;
  const cap = sectorCapFor(context.policy, sector);
  if (cap === undefined) return undefined;

  const currentValue = context.positions
    .filter((position) => sectorForSymbol(normalizeSymbol(position.symbol), context.positions, context.marketScan) === sector)
    .reduce((sum, position) => sum + position.marketValue, 0);
  const projectedValue = proposal.side === "buy" ? currentValue + notional : Math.max(0, currentValue - notional);
  const projectedPct = context.portfolio.totalMarketValue > 0 ? (projectedValue / context.portfolio.totalMarketValue) * 100 : 0;
  return { sector, projectedPct, cap };
}

function riskRuleReason(proposal: TradeProposal, context: PolicyContext): string | undefined {
  if (proposal.side !== "buy") return undefined;
  const position = context.positions.find((item) => normalizeSymbol(item.symbol) === normalizeSymbol(proposal.symbol));
  if (!position || position.averageCost <= 0) return undefined;
  const currentPrice = currentPriceForPosition(position, context.marketScan);
  if (!currentPrice) return undefined;
  const returnPct = ((currentPrice - position.averageCost) / position.averageCost) * 100;
  const stopLossPct = context.policy.riskRules.stopLossPct ?? 0;
  const takeProfitPct = context.policy.riskRules.takeProfitPct ?? 0;
  if (stopLossPct > 0 && returnPct <= -stopLossPct) {
    return `Stop-loss rule blocks adding to ${normalizeSymbol(proposal.symbol)} while it is down ${Math.abs(returnPct).toFixed(2)}%.`;
  }
  if (takeProfitPct > 0 && returnPct >= takeProfitPct) {
    return `Take-profit rule blocks adding to ${normalizeSymbol(proposal.symbol)} while it is up ${returnPct.toFixed(2)}%.`;
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
