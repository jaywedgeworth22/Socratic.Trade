import type { DerivedMetrics } from "./derived-metrics";

export type OrderSide = "buy" | "sell" | "short" | "cover";
export type OrderType = "market" | "limit" | "stop_market" | "stop_limit";
export type TimeInForce = "gfd" | "gtc";
export type MarketHours = "regular_hours" | "extended_hours" | "all_day_hours";
export type AllowlistUniverse = "custom" | "sp500";
export type StrategyAuthority = "propose" | "decide";
/** Intended holding horizon — shapes the agent's setup selection, exit timing, and tax awareness. */
export type HoldingHorizon = "intraday" | "swing" | "position" | "longterm";
export type FillSource = "live" | "paper";
export type NotificationEventType = "fill" | "block" | "run_failed" | "pending_approval" | "kill_switch";
export type NotificationStatus = "sent" | "failed" | "skipped";
/** Direction of a bar-based technical read (TradingView push or in-house computed). */
export type TechnicalDirection = "bullish" | "bearish" | "neutral";

export interface ScoringWeights {
  liquidity: number;
  momentum: number;
  value: number;
  quality: number;
  volatility: number;
  sentiment: number;
  /** Smart-money positioning: congressional net buying, insider buying, short-squeeze potential. */
  positioning: number;
  diversification: number;
}

/** US tax-mitigation settings (estimates only — not tax advice). */
export interface TaxSettings {
  /** Block the agent from rebuying a symbol it closed at a loss within 30 days (IRC §1091). */
  washSaleGuard: boolean;
  /** Marginal rate applied to short-term realized gains (ordinary income), e.g. 24. */
  shortTermRatePct: number;
  /** Marginal rate applied to long-term realized gains, e.g. 15. */
  longTermRatePct: number;
  /** When true, the Performance view shows realized P&L net of the estimated tax burden. */
  subtractFromResults?: boolean;
}

/** Tunable constants that are otherwise arbitrary code-level defaults. */
export interface TuningSettings {
  /** Bayesian shrinkage pseudo-count for small-sample win/return toward a neutral prior. Default 5. */
  shrinkPrior?: number;
  /** Minimum closed lots before the auto-tuner may shift factor weights (phase-7 §3.E). Default 20. */
  minClosedLotsForWeightShift?: number;
  /** Minimum % of max order notional the deterministic sizer will ever allocate. Default 10. */
  sizingFloorPct?: number;
  /** Maximum % of max order notional the deterministic sizer will ever allocate. Default 100. */
  sizingCeilingPct?: number;
}

export interface RiskRules {
  stopLossPct?: number;
  takeProfitPct?: number;
  trailingStopPct?: number;
  // SHORT_SELLING: Hard stop-loss for short positions (e.g. 5% max adverse excursion).
  // Required on any short proposal per docs/phase-7-strategy.md §C.
  shortStopLossPct?: number;
}

export interface NotificationSettings {
  webhookUrl?: string;
  enabledEvents: NotificationEventType[];
}

export interface ConnectedAccount {
  id: string;
  userId: string;
  broker: "alpaca" | "robinhood";
  environment: "paper" | "live";
  accountNumber?: string;
  label: string;
  apiKey?: string;
  apiSecret?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
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
  volume?: number;
  asOf?: string;
  provider?: string;
}

export interface TradingPolicy {
  enabled: boolean;
  paperMode: boolean;
  paperStartingCash: number;
  killSwitch: boolean;
  accountNumber?: string;
  connectedAccountId?: string;
  universe: AllowlistUniverse;
  strategyAuthority: StrategyAuthority;
  /** Intended holding horizon for new positions (default "swing" — days to weeks). */
  holdingHorizon?: HoldingHorizon;
  allowlist: string[];
  maxOrderNotional: number;
  maxDailyNotional: number;
  maxSymbolExposurePct: number;
  maxDailyOrders: number;
  maxProposalsPerRun: number;
  permittedOrderTypes: OrderType[];
  permitExtendedHours: boolean;
  runCadenceMinutes: number;
  evaluatorCadenceHours?: number;
  runDuringExtendedHours: boolean;
  scoringWeights: ScoringWeights;
  sectorCaps: Record<string, number>;
  riskRules: RiskRules;
  notificationSettings: NotificationSettings;
  taxSettings?: TaxSettings;
  tuning?: TuningSettings;
  activeProfileId?: string;
  activeBroker?: "alpaca" | "robinhood";
  // SHORT_SELLING: Feature gate for short/cover order sides.
  // When true, policy.ts will allow short/cover proposals through (with stricter
  // guardrails). When false or absent, short/cover proposals are unconditionally
  // rejected. Requires broker-side support (Robinhood does not currently support
  // equity shorting via MCP). See docs/phase-7-strategy.md §C.
  shortSellingEnabled?: boolean;
  // SHORT_SELLING: Per-order notional cap for short positions. Should be lower
  // than maxOrderNotional per the design doc's risk guidance.
  maxShortOrderNotional?: number;
  // SHORT_SELLING: Max total short exposure as a percentage of portfolio value.
  maxShortExposurePct?: number;
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
  tradeThesisTag: string;
  entryMarketRegime: string;
  confidenceScore?: number;
}

// Per-field provenance: which provider supplied each enriched value. Used for the
// single-source tooltips in the market scan table.
export type EnrichmentSources = Partial<
  Record<
    "price" | "bid" | "ask" | "intradayChangePct" | "asOf" | "sentiment" | "peRatio" | "analystRating" | "sector" | "industry" | "volume" | "dividendYield" | "eps" | "companyName" | "insiderSentiment" | "fcfYield" | "debtToEquity" | "epsGrowth" | "senateTrades",
    string
  >
>;

export interface AnalystRatingDetail {
  score: number;
  label: string;
  counts?: { strongBuy: number; buy: number; hold: number; sell: number; strongSell: number };
  mean?: number;
}

export interface MarketQuote {
  symbol: string;
  companyName?: string;
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
  analystRating?: string;
  analystScore?: number;
  analystBySource?: Record<string, AnalystRatingDetail>;
  dividendYield?: number;
  eps?: number;
  pbRatio?: number;
  shortPercentOfFloat?: number;
  beta?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  insiderSentiment?: number;
  fcfYield?: number;
  debtToEquity?: number;
  epsGrowth?: number;
  senateTrades?: number; // Net congressional trade signal (distinct buy members minus sell members)
  /** Cross-sectional: this name's intraday % move minus the average move of its sector among
   *  the scan candidates. >0 = outperforming its sector today (relative strength). Computed in-house. */
  sectorRelStrength?: number;
  /** Bar-based technical strength, 0–100 (50 = neutral). From the technical web source
   *  (TradingView push or in-house computed). Lifts/dings `momentumScore`. */
  technicalScore?: number;
  technicalDirection?: TechnicalDirection;
  /** Named technical conditions that fired, e.g. ["sma50_200_golden_cross","rsi_reclaim_oversold"]. */
  technicalSignals?: string[];
  evidenceBulletins?: string[]; // 1-line backend web-source bulletins (congress, insider, etc.)
  sources?: EnrichmentSources;
}

export interface MarketScan {
  source: string;
  generatedAt: string;
  scannedSymbols: number;
  returnedQuotes: number;
  /** Market breadth: % of the full screener advancing today (risk-on/off gauge). */
  breadthPct?: number;
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

/**
 * Compact per-candidate evidence digest persisted in the per-run `signal_snapshot`
 * audit for the FULL scored set — chosen AND skipped — so future learning can
 * correlate the deterministic evidence that preceded a decision with its realized
 * outcome (signal efficacy), run counterfactuals on names that were passed over
 * (forward return from `refPrice`), and attribute outcomes to the dominant factor
 * (`factorBreakdown`). Raw provider rows stay out; only this digest is stored.
 */
export interface CandidateEvidence {
  symbol: string;
  /** true = the agent acted on it this run; false = top-ranked but skipped. */
  chosen: boolean;
  side?: OrderSide; // present when chosen
  status?: string; // proposal status when chosen (placed/paper/proposed/blocked)
  thesisTag?: string; // present when chosen
  /** Run market regime — the same deterministic regime for every candidate this run. */
  regime: string;
  score?: number;
  /** Decision-time price; the anchor for counterfactual forward-return tracking. */
  refPrice?: number;
  sector?: string;
  factorBreakdown?: MarketFactorBreakdown;
  congressNet?: number; // senateTrades (distinct buy members minus sell members)
  insiderSentiment?: number;
  shortPercentOfFloat?: number;
  beta?: number;
  intradayChangePct?: number;
  sectorRelStrength?: number; // intraday move vs sector average at decision time
  technicalScore?: number; // bar-based technical strength 0–100 at decision time
  technicalDirection?: TechnicalDirection;
  technicalSignals?: string[]; // named technical conditions that fired
  asOf?: string; // candidate data freshness (most-recent enrichment timestamp)
  provider?: string; // primary provider
  sources?: EnrichmentSources; // per-field provenance (source attribution)
  bulletins?: string[]; // up to 3 web-source evidence bulletins
  /** Backend-derived ratios at decision time (PEG, earnings yield, ROE, payout, $ volume, spread).
   *  Persisted so the learning loop can correlate, e.g., low-PEG entries with realized outcomes. */
  derived?: DerivedMetrics;
}

export interface MarketQuoteSummary {
  symbol: string;
  companyName?: string;
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
  analystRating?: string;
  analystScore?: number;
  analystBySource?: Record<string, AnalystRatingDetail>;
  dividendYield?: number;
  eps?: number;
  pbRatio?: number;
  shortPercentOfFloat?: number;
  beta?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  insiderSentiment?: number;
  fcfYield?: number;
  debtToEquity?: number;
  epsGrowth?: number;
  senateTrades?: number;
  evidenceBulletins?: string[];
  sources?: EnrichmentSources;
}

export interface MarketDataProviderOptions {
  scoringWeights?: ScoringWeights;
  ttlMs?: number;
  userId?: string;
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

export interface EquityOrderInput {
  accountNumber: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity?: number;
  dollarAmount?: number;
  limitPrice?: number;
  stopPrice?: number;
  timeInForce: TimeInForce;
  marketHours: MarketHours;
}

export interface BrokerGateway {
  getAccounts(): Promise<BrokerageAccount[]>;
  getPortfolio(accountNumber: string): Promise<Portfolio>;
  getEquityPositions(accountNumber: string): Promise<EquityPosition[]>;
  getEquityOrders(accountNumber: string): Promise<EquityOrder[]>;
  getEquityQuotes(accountNumber: string, symbols: string[]): Promise<Record<string, BrokerQuote>>;
  getEquityTradability(accountNumber: string, symbols: string[]): Promise<Record<string, { tradable: boolean; fractional: boolean; reason?: string }>>;
  reviewEquityOrder(input: EquityOrderInput): Promise<ReviewedOrder>;
  placeEquityOrder(input: EquityOrderInput & { refId: string }): Promise<ExecutedOrder>;
  cancelEquityOrder(accountNumber: string, orderId: string): Promise<ExecutedOrder>;
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

export interface StrategyOutcome {
  proposalId?: string;
  runId?: string;
  accountNumber: string;
  source: "paper" | "live";
  symbol: string;
  side: "buy" | "sell" | "short" | "cover";
  rationale: string;
  entryPrice?: number;
  entryAt?: string;
  exitPrice?: number;
  exitAt?: string;
  currentPrice?: number;
  realizedPnl?: number;
  unrealizedPnl?: number;
  returnPct?: number;
  holdingDays?: number;
  sector?: string;
  tradeThesisTag?: string; // e.g., Mean Reversion, Breakout, Value
  riskExit?: "stop_loss" | "take_profit" | "trailing_stop";
  entryMarketRegime?: any; // Snapshot of SPY, QQQ, VIX at entry
  exitMarketRegime?: any; // Snapshot of SPY, QQQ, VIX at exit
  mae?: number; // Maximum Adverse Excursion during holding
  mfe?: number; // Maximum Favorable Excursion during holding
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

export interface StrategyTuningPatch {
  prompt?: string;
  scoringWeights?: Partial<ScoringWeights>;
  policy?: Partial<
    Pick<
      TradingPolicy,
      | "maxOrderNotional"
      | "maxDailyNotional"
      | "maxSymbolExposurePct"
      | "maxDailyOrders"
      | "maxProposalsPerRun"
      | "runCadenceMinutes" | "evaluatorCadenceHours"
      | "universe"
      | "strategyAuthority"
      | "runDuringExtendedHours"
    >
  > & {
    riskRules?: Partial<RiskRules>;
    sectorCaps?: Record<string, number>;
  };
}

export interface StrategyTuningProposal {
  summary: string;
  rationale: string;
  marketContext: string;
  performanceReadout: string;
  proposedPatch: StrategyTuningPatch;
  cautions: string[];
  confidenceScore: number;
  generatedBy: "llm" | "local_rules";
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
