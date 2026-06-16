# Phase 7 - Strategy Learning Loop (Design)

Design only. Phase 7 should let the agent learn from prior trade outcomes and condition
new recommendations on current market regime without changing strategy behavior
autonomously.

## Motivation

Today `runStrategyOnce` builds each LLM request from current portfolio state, market scan
data, daily limits, and macro context. It does not feed prior recommendation outcomes
back into the next decision, even though the app already persists the inputs needed for
that loop: `trade_proposals`, `fill_events`, `portfolio_snapshots`, and P&L helpers in
`src/lib/performance.ts`.

## Implementation Architecture

- Add `src/lib/outcomes.ts` for derived outcome memory. Keep this module read-only in v1:
  it derives outcomes from existing persisted rows and does not introduce migrations.
- Add `buildStrategyOutcomes(accountNumber, source, options)` returning normalized
  `StrategyOutcome[]` for `source = "paper"` or `source = "live"`.
- Add `buildOutcomeDigest(accountNumber, source, options)` returning a compact string for
  prompt injection. Default limit: last 25 outcomes. Target size: 300-500 tokens.
- Use read-time joins in v1:
  `trade_proposals` by `proposal_id/run_id` -> `fill_events` by `proposal_id/run_id` ->
  latest available mark prices from `MarketScan.quotesBySymbol` or portfolio snapshots.
- Defer a materialized `strategy_outcomes` table until read-time joins become too slow.
  If added later, update it from fill insertion, reconciliation, and close detection.

Public type:

```ts
export interface StrategyOutcome {
  proposalId?: string;
  runId?: string;
  accountNumber: string;
  source: "paper" | "live";
  symbol: string;
  side: "buy" | "sell";
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
  dominantFactor?: string;
  riskExit?: "stop_loss" | "take_profit" | "trailing_stop";
}
```

## Phase 7a - Outcome Memory And Reflection Digest

Goal: let the agent see the results of prior recommendations before making new ones.

- Build FIFO outcome attribution from `fill_events`, preserving the original proposal
  rationale from `trade_proposals.proposal.rationale`.
- For open lots, compute unrealized P&L from the newest available mark price. If no mark
  exists, include the outcome with entry data and omit return/P&L fields.
- Capture sector from `MarketScan.sectorBySymbol`, enriched quote metadata, or position
  metadata. Capture `dominantFactor` as the highest non-diversification factor from the
  candidate's `factorBreakdown` when available.
- Detect risk exits by matching sell proposals/fills whose rationale or proposal source
  came from `generateProactiveRiskProposals` stop-loss/take-profit/trailing-stop logic.
- Add a "Lessons from recent trades" block to the LLM context in `proposeTrades`.
  It should include win rate, average return, best/worst rationales, sector/factor notes,
  and recent stop-outs. If there are no outcomes, omit the block entirely.
- Audit the exact digest used on each run with `audit("strategy_outcome_digest", ...)`,
  including `runId`, `accountNumber`, `source`, outcome count, and digest text.

Acceptance:

- Digest reflects realized and unrealized P&L for the selected mode only.
- Empty history causes no prompt block and no error.
- Every non-empty digest used by a run is auditable.

## Phase 7b - Deeper Market Conditioning

Goal: make recommendations react to regime and live news, not only fundamentals.

- Extend macro context with a `marketRegime` object derived from Yahoo-backed market data:
  `SPY` trend, `QQQ` trend, `^VIX` level, and breadth across the current scan universe.
- Keep existing FRED fields intact: fed funds, DGS10, CPI, and unemployment.
- Add held-position headlines to the prompt for symbols currently held in the active mode.
  Reuse the enrichment provider and cache so this does not create a second uncached news path.
- Degrade gracefully: if Yahoo, Finnhub, or FRED fail, keep the strategy run alive and omit
  only the unavailable fields with a warning in scan/macro metadata.

Acceptance:

- Prompt carries regime summary and per-holding headlines when available.
- Missing data sources do not block scans, strategy runs, or proposal approval.

## Phase 7c - Human-Approved Auto-Tuning

Goal: suggest strategy improvements from accumulated outcomes without autonomous policy
changes.

- Add advisory suggestions that analyze outcome performance by scoring factor, sector,
  order side, and prompt/rationale themes.
- Suggestions can include bounded scoring-weight deltas or prompt guidance text.
- Default guardrails:
  - minimum 20 outcomes before suggesting;
  - maximum 5-point scoring-weight delta per suggestion;
  - one pending suggestion per active profile;
  - never auto-apply;
  - full audit trail for generated, approved, rejected, and applied suggestions.
- Suggested future storage:

```sql
CREATE TABLE strategy_learning_suggestions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  account_number TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  suggestion TEXT NOT NULL,
  rationale TEXT NOT NULL,
  proposed_policy_patch TEXT,
  proposed_prompt_patch TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
```

- Dashboard behavior: show pending suggestions in a Learning panel with Approve and Reject.
  Approve writes the patch into the active `StrategyProfile`; Reject only updates status.

Acceptance:

- Suggestions are visible, bounded, and human-approved.
- Live and Paper learning suggestions are kept separate.
- No strategy behavior changes until a suggestion is approved.

## Test Plan

- Outcome digest fixture: seed buy/sell fills and open lots, assert FIFO realized P&L,
  unrealized marks, holding days, and digest text.
- Prompt/audit fixture: run strategy with and without outcomes, assert digest block is
  present only when non-empty and the audit payload contains the exact digest.
- Regime/news fallback tests: stub Yahoo/Finnhub/FRED success and failure paths; assert
  prompt fields appear when available and runs continue when unavailable.
- Suggestion guardrail tests: assert minimum sample size, max 5-point delta, one pending
  suggestion per profile, approval-only application, rejection, and audit events.

## Sequencing

1. Implement 7a first. It is independently useful and provides the data foundation for 7c.
2. Implement 7b next or in parallel; it is independent of outcome memory.
3. Implement 7c last after outcome attribution is stable.
