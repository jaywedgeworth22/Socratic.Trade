import type { DerivedMetrics } from "./derived-metrics";

export type OrderSide = "buy" | "sell" | "short" | "cover";
export type OrderType = "market" | "limit" | "stop_market" | "stop_limit";
export type TimeInForce = "gfd" | "gtc";
export type MarketHours = "regular_hours" | "extended_hours" | "all_day_hours";
export type IndexUniverse = "sp500" | "nasdaq100" | "dow30";
export type SystemState = "active" | "halted" | "close_only" | "liquidating";
export type StrategyAuthority = "propose" | "decide";
/** Intended holding horizon — shapes the agent's setup selection, exit timing, and tax awareness. */
export type HoldingHorizon = "intraday" | "swing" | "position" | "longterm";
export type FillSource = "live" | "paper";
export type NotificationEventType = "fill" | "block" | "run_failed" | "pending_approval" | "kill_switch" | "price_alert" | "proposal_withdrawn";
export type PriceAlertOp = "<" | ">";
export type PriceAlertStatus = "armed" | "triggered";

export interface PriceAlert {
  id: string;
  userId: string;
  symbol: string;
  op: PriceAlertOp;
  price: number;
  note: string;
  status: PriceAlertStatus;
  createdAt: string;
  triggeredAt: string | null;
  triggeredPrice: number | null;
}

export interface WatchlistItem {
  symbol: string;
  addedAt: string;
}
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
/**
 * Tax treatment of an account. IRAs (Roth/Traditional) are tax-sheltered: there is no annual
 * capital-gains tax, and the IRC §1091 wash-sale lockout does not apply WITHIN a single IRA
 * (a wash sale has no benefit there). A loss realized in a TAXABLE account, however, still locks
 * rebuys of that symbol across ALL of the user's accounts — including the IRAs — for 30 days,
 * because buying the replacement in the IRA permanently destroys the disallowed basis.
 */
export type TaxationType = "taxable" | "roth_ira" | "traditional_ira";

/**
 * What a brokerage account can actually do. Populated from the broker API on
 * connect and stored as a JSON blob alongside the account row. Every boolean
 * field defaults to false so legacy/unpopulated rows are never accidentally
 * granted a capability the broker hasn't confirmed.
 *
 * Future asset classes (futures, crypto) are included here so policy checks
 * can reference capabilities.futuresTrading without a later schema change —
 * they will simply read false until the broker gateway sets them.
 */
export interface AccountCapabilities {
  /** Equity (stock/ETF) buying and selling. True for all current brokers. */
  equityTrading: boolean;
  /**
   * Equity short selling (borrowing shares to sell).
   * Robinhood MCP: always false — the MCP's review_equity_order explicitly
   * prohibits short sells. Alpaca: parsed from account.shorting_enabled.
   */
  shortSelling: boolean;
  /** Options contracts allowed at all. */
  optionsTrading: boolean;
  /**
   * CBOE/broker options approval tier:
   *   0 = none  1 = covered calls + cash-secured puts
   *   2 = long calls/puts  3 = spreads/straddles  4 = naked/uncovered
   * Undefined when optionsTrading is false or the broker does not report a level.
   */
  optionsLevel?: 0 | 1 | 2 | 3 | 4;
  /** Futures/commodities contracts. Not supported by any current broker. */
  futuresTrading: boolean;
  /**
   * Cryptocurrency spot trading. Not supported by current stock brokers.
   * Reserved for future crypto-exchange connections — wire a crypto gateway
   * and set this true there; stock brokers remain false.
   */
  cryptoTrading: boolean;
  /** Whether the account has margin (borrowing) enabled. */
  marginEnabled: boolean;
  /** Broker's required maintenance margin percentage (e.g. 25 = 25%). */
  marginRequirementPct?: number;
  /**
   * Account structure, which determines the applicable tax regime:
   *   "brokerage"       → standard taxable account
   *   "traditional_ira" → tax-deferred (contributions pre-tax; withdrawals taxed as income)
   *   "roth_ira"        → tax-free growth (contributions post-tax; qualified withdrawals free)
   *   "crypto_exchange" → crypto-only venue; taxable but no equity trading
   * For new accounts this supersedes the separate taxationType field on ConnectedAccount.
   */
  accountType: "brokerage" | "traditional_ira" | "roth_ira" | "crypto_exchange";
}

export interface TaxSettings {
  /** Tax treatment driving rates + wash-sale handling. Defaults to "taxable". */
  taxationType?: TaxationType;
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
  /** Minimum proposal confidenceScore that triggers Red Team review. Default 80. */
  redTeamConvictionThreshold?: number;
  /** Optional max opening order notional as % of portfolio in crisis/inverted regimes. Undefined or <=0 disables. */
  crisisMaxOpeningExposurePct?: number;
}

export interface RiskRules {
  stopLossPct?: number;
  stopLossNotional?: number;
  takeProfitPct?: number;
  takeProfitNotional?: number;
  trailingStopPct?: number;
  stopLossAtrMultiple?: number;
  // SHORT_SELLING: Hard stop-loss for short positions (e.g. 5% max adverse excursion).
  // Required on any short proposal per docs/phase-7-strategy.md §C.
  shortStopLossPct?: number;
  /**
   * Account-level circuit breaker: max trailing drawdown (%) from the equity high-water mark
   * before the system auto-halts new entries (systemState → "close_only") and fires a
   * kill-switch notification. Undefined or <=0 disables. Unlike the per-position stopLossPct,
   * this bounds the whole account's bleed, not one name's. Evaluated at the top of each run.
   */
  maxDrawdownPct?: number;
  /**
   * Account-level circuit breaker: max single-day equity loss (account currency) from the day's
   * starting equity before auto-halting new entries. Undefined or <=0 disables.
   */
  maxDailyLossNotional?: number;
}

export interface NotificationSettings {
  webhookUrl?: string;
  enabledEvents: NotificationEventType[];
}

export interface ConnectedAccount {
  id: string;
  userId: string;
  /**
   * Broker identifier. Add new values here when connecting a new venue
   * (e.g. "coinbase" for a crypto exchange) and wire a matching BrokerGateway.
   */
  broker: "alpaca" | "alpaca-mcp" | "robinhood" | "test";
  environment: "paper" | "live";
  /**
   * @deprecated Use capabilities.accountType instead for new accounts.
   * Retained for backwards compatibility with existing rows that predate
   * the AccountCapabilities field.
   */
  taxationType?: TaxationType;
  accountNumber?: string;
  label: string;
  apiKey?: string;
  apiSecret?: string;
  baseUrl?: string;
  isActive: boolean;
  /**
   * Persisted snapshot of the capabilities last reported by the broker for
   * this account. Populated on connect/re-sync; undefined for legacy rows
   * (treat all capabilities as false when absent).
   */
  capabilities?: AccountCapabilities;
  createdAt: string;
  updatedAt: string;
}

export interface BrokerageAccount {
  accountNumber: string;
  label: string;
  agenticAllowed: boolean;
  /** Live capabilities reported by the broker for this account. */
  capabilities?: AccountCapabilities;
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
  systemState: SystemState;
  paperMode: boolean;
  paperStartingCash: number;
  accountNumber?: string;
  connectedAccountId?: string;
  includedIndices: IndexUniverse[];
  additionalSymbols: string[];
  blocklist?: string[];
  strategyAuthority: StrategyAuthority;
  /** Intended holding horizon for new positions (default "swing" — days to weeks). */
  holdingHorizon?: HoldingHorizon;
  maxOrderNotional?: number;
  maxOrderPctOfNav?: number;
  maxDailyNotional?: number;
  /** Hard ceiling on total order notional executed within any rolling 60-minute window. On breach the account auto-reverts strategyAuthority to "propose" and the order is rejected. */
  maxHourlyNotional?: number;
  /** Allow synthetic trailing-stop monitoring to act during extended hours. Default false (regular hours only). */
  allowExtendedHoursSyntheticStops?: boolean;
  maxDailyPctOfNav?: number;
  maxSymbolExposurePct?: number;
  maxSymbolExposureNotional?: number;
  maxGrossExposurePct?: number;
  maxNetExposurePct?: number;
  maxDailyOrders: number;
  maxProposalsPerRun: number;
  /**
   * Hard time-to-live for a still-pending (unapproved/unrejected) proposal, in minutes.
   * A proposal older than this is auto-expired (status → "expired") so the approval queue
   * never implies the agent is still actively recommending an hours/days-old idea. 0 or
   * undefined disables hard expiry — the on-run LLM re-validation below still applies.
   */
  proposalExpiryMinutes?: number;
  /**
   * How often each still-pending proposal is re-validated by the LLM, as the minimum hours
   * between re-checks for a given proposal. Re-checks ride on strategy runs and happen during
   * regular market hours only (never overnight). 0 = every run; 24 = once per day; 120 = every
   * 5 days. Default 0 (every run).
   */
  proposalRevalidateCadenceHours?: number;
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
  activeBroker?: "alpaca" | "alpaca-mcp" | "robinhood" | "test";
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
    "price" | "bid" | "ask" | "intradayChangePct" | "asOf" | "sentiment" | "peRatio" | "analystRating" | "sector" | "industry" | "volume" | "dividendYield" | "eps" | "companyName" | "insiderSentiment" | "fcfYield" | "debtToEquity" | "epsGrowth" | "senateTrades" | "vwap",
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
  /** Latest available daily volume-weighted average price. Source-provided only; never fabricated. */
  vwap?: number;
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
  vwap?: number;
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
  /** Last time a strategy run re-validated this still-pending proposal via the LLM. */
  lastRevalidatedAt?: string;
  /** The LLM's most recent re-validation note (why it still stands). */
  revalidationNote?: string;
  accountNumber?: string;
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
  entryMarketRegime?: string; // Snapshot of SPY, QQQ, VIX at entry
  exitMarketRegime?: string; // Snapshot of SPY, QQQ, VIX at exit
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
      | "maxHourlyNotional"
      | "maxSymbolExposurePct"
      | "maxDailyOrders"
      | "maxProposalsPerRun"
      | "runCadenceMinutes" | "evaluatorCadenceHours"
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

// --- Out-of-app multi-channel alert delivery (ported from Atlas) ---
/** Out-of-app delivery channels for triggered alerts. */
export type NotifyChannelId = "push" | "webhook" | "email" | "sms";

/** Per-user notification preferences: enabled channels + per-channel delivery target. */
export interface NotifyPrefs {
  userId: string;
  channels: NotifyChannelId[];
  pushTarget: string;
  webhookUrl: string;
  email: string;
  phone: string;
  updatedAt: string | null;
}

export interface NotifyMessage {
  title: string;
  body: string;
  kind?: string;
  data?: unknown;
}

export interface NotifyChannelResult {
  channel: NotifyChannelId;
  ok: boolean;
  skipped?: "not_configured" | "no_target";
  error?: string;
}

/** UI metadata so the client shows only usable channels and the right target field. */
export interface NotifyChannelDescriptor {
  id: NotifyChannelId;
  label: string;
  available: boolean;
  provider?: string | null;
  targetField: string;
  targetLabel: string;
  placeholder: string;
  hint: string;
}

// --- Conversation transcript (chat history, ported from Atlas) ---
export type ChatTurnRole = "user" | "assistant";

export interface ChatTurn {
  id: string;
  userId: string;
  role: ChatTurnRole;
  text: string;
  citations: string[];
  intent: string | null;
  /** True when redact-on-write stripped a secret/PII from `text` before persistence. */
  redacted: boolean;
  createdAt: string;
}

// --- Salience-gated per-user memory (Atlas Deep Dive 12) ---
export type MemoryKind = "constraint" | "preference" | "goal" | "correction" | "pattern" | "decision" | "oneoff";
export type MemoryDecision = "WRITE" | "HOLD" | "SKIP";

/** A scored extraction candidate (pre-persistence). */
export interface MemoryCandidate {
  kind: MemoryKind;
  subject: string;
  value: string;
  source: string;
  confidence: number;
  hard: boolean;
  specificity: number;
  pii: boolean;
}

/** A persisted memory. `supersededBy` non-null means it was reconciled away by a newer value. */
export interface MemoryItem {
  id: string;
  userId: string;
  kind: MemoryKind;
  subject: string;
  value: string;
  source: string;
  confidence: number;
  hard: boolean;
  assertedAt: string;
  supersededBy: string | null;
}
