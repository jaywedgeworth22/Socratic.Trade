export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit" | "stop_market" | "stop_limit";
export type TimeInForce = "gfd" | "gtc";
export type MarketHours = "regular_hours" | "extended_hours" | "all_day_hours";
export type AllowlistUniverse = "custom" | "sp500";
export type StrategyAuthority = "propose" | "decide";
export type FillSource = "live" | "paper";
export type NotificationEventType = "fill" | "block" | "run_failed" | "pending_approval" | "kill_switch";
export type NotificationStatus = "sent" | "failed" | "skipped";

export interface ScoringWeights {
  liquidity: number;
  momentum: number;
  value: number;
  quality: number;
  volatility: number;
  sentiment: number;
  diversification: number;
}

export interface RiskRules {
  stopLossPct?: number;
  takeProfitPct?: number;
  trailingStopPct?: number;
}

export interface NotificationSettings {
  webhookUrl?: string;
  enabledEvents: NotificationEventType[];
}

export interface BrokerageAccount {
  accountNumber: string;
  label: string;
  agenticAllowed: boolean;
}

export interface Portfolio {
  accountNumber: string;
  totalMarketValue: number;
  buyingPower: number;
  equityMarketValue: number;
  optionMarketValue: number;
  cash: number;
}

export interface EquityPosition {
  symbol: string;
  quantity: number;
  averageCost: number;
  marketValue: number;
  sector?: string;
  industry?: string;
}

export interface EquityOrder {
  id: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  state: string;
  quantity?: number;
  dollarAmount?: number;
  filledQuantity?: number;
  averagePrice?: number;
  createdAt: string;
  updatedAt?: string;
  placedAgent?: string;
}

export interface BrokerQuote {
  symbol: string;
  price?: number;
  bid?: number;
  ask?: number;
  asOf?: string;
  provider?: string;
}

export interface TradingPolicy {
  enabled: boolean;
  paperMode: boolean;
  paperStartingCash: number;
  killSwitch: boolean;
  accountNumber?: string;
  universe: AllowlistUniverse;
  strategyAuthority: StrategyAuthority;
  allowlist: string[];
  maxOrderNotional: number;
  maxDailyNotional: number;
  maxSymbolExposurePct: number;
  maxDailyOrders: number;
  maxProposalsPerRun: number;
  permittedOrderTypes: OrderType[];
  permitExtendedHours: boolean;
  runCadenceMinutes: number;
  runDuringExtendedHours: boolean;
  scoringWeights: ScoringWeights;
  sectorCaps: Record<string, number>;
  riskRules: RiskRules;
  notificationSettings: NotificationSettings;
  activeProfileId?: string;
}

export interface TradeProposal {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity?: number;
  dollarAmount?: number;
  limitPrice?: number;
  stopPrice?: number;
  timeInForce: TimeInForce;
  marketHours: MarketHours;
  rationale: string;
}

export interface MarketQuote {
  symbol: string;
  price: number;
  bid?: number;
  ask?: number;
  volume: number;
  marketCap?: number;
  intradayChangePct: number;
  netChange?: number;
  sector?: string;
  industry?: string;
  positionMarketValue: number;
  score: number;
  factorBreakdown?: MarketFactorBreakdown;
  provider?: string;
  stale?: boolean;
  cached?: boolean;
  asOf?: string;
  sentiment?: number;
  peRatio?: number;
  headlines?: string[];
}

export interface MarketScan {
  source: string;
  generatedAt: string;
  scannedSymbols: number;
  returnedQuotes: number;
  topCandidates: MarketQuote[];
  sectorBySymbol: Record<string, string>;
  quotesBySymbol: Record<string, MarketQuoteSummary>;
  cacheTtlMs?: number;
  cached?: boolean;
  warnings: string[];
}

export type MarketFactor = keyof ScoringWeights;

export type MarketFactorBreakdown = Record<MarketFactor, number> & {
  weightedTotal: number;
};

export interface MarketQuoteSummary {
  symbol: string;
  price: number;
  bid?: number;
  ask?: number;
  sector?: string;
  industry?: string;
  score: number;
  provider?: string;
  asOf?: string;
  sentiment?: number;
  peRatio?: number;
}

export interface MarketDataProviderOptions {
  scoringWeights?: ScoringWeights;
  ttlMs?: number;
}

export interface MarketDataProvider {
  name: string;
  scan(symbols: string[], positions: EquityPosition[], options?: MarketDataProviderOptions): Promise<MarketScan>;
}

export interface PolicyDecision {
  approved: boolean;
  reasons: string[];
  projectedSymbolExposurePct?: number;
  dailyNotionalUsed?: number;
}

export interface ReviewedOrder {
  estimatedNotional: number;
  alerts: string[];
  raw: unknown;
}

export interface ExecutedOrder {
  orderId?: string;
  refId: string;
  state: string;
  filledQuantity?: number;
  averagePrice?: number;
  raw: unknown;
}

export interface StrategyRun {
  id: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "completed" | "failed";
  summary?: string;
}

export interface StrategyRunRow {
  id: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "completed" | "failed";
  summary?: string;
  placedCount: number;
  paperCount: number;
  blockedCount: number;
  proposedCount: number;
  totalCount: number;
}

export interface PendingProposal {
  id: string;
  createdAt: string;
  proposal: TradeProposal;
  decision: PolicyDecision;
  review?: ReviewedOrder;
}

export interface StrategyProfile {
  id: string;
  name: string;
  policy: TradingPolicy;
  prompt: string;
  scoringWeights: ScoringWeights;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PortfolioSnapshot {
  id: string;
  runId?: string;
  accountNumber: string;
  source: FillSource;
  equity: number;
  cash: number;
  buyingPower: number;
  positionsValue: number;
  positions: EquityPosition[];
  createdAt: string;
}

export interface FillEvent {
  id: string;
  proposalId?: string;
  runId?: string;
  accountNumber: string;
  source: FillSource;
  symbol: string;
  side: OrderSide;
  quantity: number;
  price: number;
  notional: number;
  status: string;
  brokerOrderId?: string;
  raw?: unknown;
  filledAt: string;
}

export interface EquityCurvePoint {
  timestamp: string;
  equity: number;
  source: FillSource;
}

export interface RunAttribution {
  runId: string;
  fillCount: number;
  notional: number;
  realizedPnl: number;
}

export interface PerformanceSummary {
  liveEquityCurve: EquityCurvePoint[];
  paperEquityCurve: EquityCurvePoint[];
  liveRealizedPnl: number;
  paperRealizedPnl: number;
  liveUnrealizedPnl: number;
  paperUnrealizedPnl: number;
  liveWinRate: number;
  paperWinRate: number;
  liveAverageReturnPct: number;
  paperAverageReturnPct: number;
  attribution: RunAttribution[];
  fills: FillEvent[];
}

export interface NotificationEvent {
  id: string;
  createdAt: string;
  type: NotificationEventType;
  title: string;
  status: NotificationStatus;
  webhookUrl?: string;
  payload: unknown;
  error?: string;
}
