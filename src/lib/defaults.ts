import type { NotificationSettings, RiskRules, ScoringWeights, TaxSettings, TradingPolicy } from "./types";

export const DEFAULT_TAX_SETTINGS: TaxSettings = {
  washSaleGuard: true,
  shortTermRatePct: 24,
  longTermRatePct: 15
};

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  liquidity: 1.4,
  momentum: 1.2,
  value: 0.8,
  quality: 0.8,
  volatility: 0.8,
  sentiment: 0.6,
  diversification: 1
};

export const DEFAULT_RISK_RULES: RiskRules = {
  stopLossPct: 8,
  takeProfitPct: 20,
  trailingStopPct: 0
};

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  webhookUrl: "",
  enabledEvents: ["fill", "block", "run_failed", "pending_approval", "kill_switch"]
};

export const DEFAULT_POLICY: TradingPolicy = {
  enabled: false,
  paperMode: true,
  paperStartingCash: 10000,
  killSwitch: false,
  universe: "custom",
  strategyAuthority: "decide",
  allowlist: [],
  maxOrderNotional: 10,
  maxDailyNotional: 500,
  maxSymbolExposurePct: 25,
  maxDailyOrders: 10,
  maxProposalsPerRun: 3,
  permittedOrderTypes: ["market", "limit"],
  permitExtendedHours: false,
  runCadenceMinutes: 60,
  runDuringExtendedHours: false,
  scoringWeights: DEFAULT_SCORING_WEIGHTS,
  sectorCaps: {},
  riskRules: DEFAULT_RISK_RULES,
  notificationSettings: DEFAULT_NOTIFICATION_SETTINGS,
  taxSettings: DEFAULT_TAX_SETTINGS
};

export const DEFAULT_STRATEGY_PROMPT = `OBJECTIVE
Maximize risk-adjusted total return on this equity account. Compound gains by rotating capital toward the strongest opportunities in the allowed universe each session.

SELECTION LOGIC
Use the market scan's topCandidates as your primary opportunity set — they are pre-ranked by a composite score of volume, momentum, and portfolio underweight. Apply judgment on top of that ranking:

  1. Prioritize candidates with strong intraday momentum (intradayChangePct > 0) AND above-average volume. High volume confirms conviction behind a move.
  2. Among equally ranked candidates, prefer sectors not already represented in the portfolio. Concentration in one sector amplifies risk without improving expected return.
  3. Avoid stocks showing a sharp single-day spike (>8%) with no prior momentum — these often revert. Prefer steady climbers over one-day wonders.
  4. Give meaningful weight to names already held that are continuing to trend — adding to a winner within position limits is higher conviction than buying something new.

SELL AND TRIM RULES
  - Trim any position that has grown above maxSymbolExposurePct. Rebalancing into other opportunities is better than letting a single name dominate.
  - Sell a held position if it is down more than 8% intraday with no sector-wide explanation. Cut losers early; the opportunity cost of staying in a falling stock is real.
  - If a held stock ranks near the bottom of the current scan while another candidate ranks highly, propose a rotation: sell the laggard, fund the leader.

SIZING AND LIMITS
  - Size orders at maxOrderNotional unless the remaining daily notional is lower.
  - Respect remainingDailyOrders — if it is low, concentrate on the single best trade rather than spreading across several mediocre ones.
  - Use market orders for stocks with marketCap >= $5B. Use limit orders for stocks with marketCap < $5B or where marketCap is unknown.
  - If a candidate includes an ask price, a buy limit may be priced near or slightly below ask. If no ask price is provided, do not invent one; use market orders for liquid names or current price-based limits for smaller names.
  - Dollar-amount orders must use regular_hours.

OUTPUT
Return a JSON proposals array. Each entry requires: symbol, side, type, dollarAmount or quantity, timeInForce (gfd), marketHours, and a rationale. The rationale must be specific — name the signal (e.g. "ranked #2 in scan, +2.1% on 3× average volume, no sector overlap" or "position exceeded 26% allocation, trimming to fund higher-ranked scan candidates"). Vague rationales like "looks good" are not acceptable.`;
