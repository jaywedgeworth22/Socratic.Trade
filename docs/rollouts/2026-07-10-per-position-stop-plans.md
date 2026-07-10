# 2026-07-10 — Per-position stop PLANS (LLM chooses stop TYPE at proposal time)

Agent: CLAUDE (cloud session, branch `claude/per-position-stop-plans`, stacked on PR #1331 /
`claude/stop-loss-preset-options-f1jygn`)

## Summary

Owner-directed follow-up to the 2026-07-10 broker-trailing-stops session (see
`docs/rollouts/2026-07-10-broker-trailing-stops-ui-consolidation.md`), building the deferred
"per-position stop PLANS" item from `docs/EFFORT-LOG.md`'s Planned list: the LLM can now choose a
stop **TYPE** (fixed / ATR / trailing / none) for a position at open time — distinct from the
existing per-trade stop **PRICE** (`bracketStopLoss`) — and that choice is persisted for the
position's life and honored by every stop-enforcement layer, not just the one that generated the
proposal.

1. **Schema + persistence.** `TradeProposal.stopPlan: { style: StopPlanStyle; rationale?: string }`
   (`StopPlanStyle = "default" | "fixed" | "atr" | "trailing" | "none"`), added to the LLM
   structured-output schema and `sanitizeProposals`. New `position_stop_plans` table
   (`user_id, account_number, symbol` primary key, `style`, `rationale`, `avg_cost`, `updated_at`)
   — structurally identical to the existing `take_profit_trims` ratchet. Committed **on FILL**
   (`recordFillFromProposal` in `performance.ts`), not at proposal time, mirroring the take-profit
   band pattern — a proposed-but-never-filled plan never persists.
2. **All four stop-enforcement layers now honor the SAME plan for a symbol:**
   - `generateProactiveRiskProposals` / `enrichOpeningProposal` (`strategy.ts`): a "fixed"/"atr"
     plan PINS that position's distance, ignoring the account's own ATR/beta toggles for it; a
     "trailing"/"none" plan makes this generator skip the position's fixed/ATR exit entirely
     (trailing is handled by the synthetic monitor; none needs no distance at all).
   - `runSyntheticStopMonitor` (`synthetic-stops.ts`): self-loads plans from the DB each tick. A
     "trailing" plan registers a synthetic trail even when the account has **no** `trailingStopPct`
     configured at all (using `STOP_PLAN_FALLBACK_STOP_PCT` = 8%). A "none" plan purges any
     existing registration — including one made **before** the plan was set (e.g. a scale-in add
     that reconsiders protection) — and is never re-registered regardless of the account-wide
     trailing config.
   - `reconcileBrokerProtectiveStops` (`broker-protective-stops.ts`): a new per-symbol
     `kindForSymbol` resolver that only **narrows** which of the account's own enabled lane(s)
     apply to one symbol — it never invents a broker capability the account doesn't otherwise
     have. "trailing" excludes the fixed lane for that symbol; "fixed"/"atr" exclude the trailing
     lane; "none" excludes both and tears down any existing resting broker-held stop for that
     symbol (never left resting in silent contradiction of the owner/LLM's choice).
3. **Universal availability (owner requirement B).** The ATR precompute in `strategy.ts` now also
   covers **opening candidate** symbols (not just held positions) when any candidate's proposal
   requests an "atr" plan, using the proposal's `referencePrice`/`limitPrice` as the entry anchor
   (the position doesn't exist yet). Combined with `STOP_PLAN_FALLBACK_STOP_PCT`, every style is
   genuinely selectable on an account with zero stop-loss/trailing configuration at all.
4. **No hidden prioritization (owner requirement A).** `app/console/guardrails/stop-flow.tsx`
   gained a 4th lane — "Per-position override" — extending the existing distance/trailing/
   enforcement diagram (not a disconnected UI element). `DashboardSnapshot` grew
   `stopPlanBySymbol` (self-loaded server-side, best-effort); `deriveProtection`
   (`app/console/lib/derive.ts`) annotates the Positions table's protection column with the active
   plan — a "none" plan is surfaced **prominently** (its own distinct label/tone, never blended
   into the generic "nothing configured" case) with its rationale; `approval-card.tsx` shows the
   LLM's chosen style + rationale in the "If you approve" summary for a fresh (non-default) plan.
5. **Pre-trade validation stance for `stopPlan: "none"`:** deliberately **not** hard-blocked in
   `policy.ts`'s `evaluateTradeProposal` — per the repo's "real trading, owner's risk" product
   philosophy, a risk-increasing owner/LLM choice is never gated. The schema already asks for a
   rationale; enforcement is honest UI surfacing (Positions column, approval card), never a
   scolding block.

## Why

The prior session (broker-trailing-stops-ui-consolidation) deliberately deferred this item —
"per-position LLM-chosen stop plans... deliberately NOT ridden along" — because it's a money-path
change spanning ~6 modules plus a migration, and needed its own verify cycle. The owner's two
sharpened requirements from that session (no hidden prioritization; universal availability) apply
directly here: a per-position plan is a NEW way the app could secretly override account settings
if not surfaced, and it must genuinely work for every symbol regardless of the account's own
configuration, or it's not really a choice.

## Decisions made

- Kept the LLM-facing schema minimal (`style` + `rationale` only, no per-trade numeric
  overrides for trail%/ATR-multiple) — the position reuses the account's own configured numeric
  parameters (or the `STOP_PLAN_FALLBACK_STOP_PCT` fallback) combined with the chosen style, to
  limit schema/validation surface area.
- `STOP_PLAN_FALLBACK_STOP_PCT = 8` lives in `src/lib/types.ts` (shared across `strategy.ts`,
  `synthetic-stops.ts`, `broker-protective-stops.ts`) rather than being duplicated per-module —
  matches `DEFAULT_POLICY.riskRules.stopLossPct` so a plan-only position gets the same protection
  a fresh account ships with by default.
- `reconcileBrokerProtectiveStops`'s per-symbol kind resolution only **narrows**, never invents:
  a "trailing" plan on an account whose only enabled lane is Robinhood's fixed stop gets **no**
  broker-held stop for that symbol (not a forced trailing stop bypassing the account's own
  `brokerTrailingStops` off-switch) — the always-on synthetic monitor is the universal fallback
  that DOES genuinely honor "trailing"/"none" per-symbol unconditionally. Broker-held enforcement
  stays what it always was: additive, narrower-scoped protection, not the universal-availability
  guarantee itself.
- Did not add a new pre-trade validation gate for `stopPlan: "none"` — consistent with the
  product-philosophy rule that risk-increasing owner choices are never hard-blocked.
- ATR precompute for opening candidates only extends to symbols the LLM actually proposed opening
  this run (not the full market-scan candidate universe) — avoids uncapped `fetchDailyOHLC` calls
  purely for prompt-time ATR-availability visibility the schema doesn't need.

## Files

- `src/lib/types.ts` — `StopPlanStyle`, `STOP_PLAN_STYLES`, `StopPlan`, `STOP_PLAN_FALLBACK_STOP_PCT`;
  `TradeProposal.stopPlan`; `EquityOrder.orderClass` (unrelated fix, see PR #1331 round 6/7 notes —
  landed via the merge chain onto this branch).
- `src/lib/db.ts` — `position_stop_plans` CREATE TABLE (baseline `migrate()` block — brand-new
  table, no versioned migration needed).
- `src/lib/db-api-keys.ts` — `PositionStopPlan`, `getStopPlans`/`recordStopPlan`/`clearStopPlans`.
- `src/lib/performance.ts` — `recordFillFromProposal` persists a fresh non-default `stopPlan` on
  an opening buy/short fill.
- `src/lib/strategy.ts` — `stopPlanSchema` (LLM tool-call schema) + `sanitizeProposals` coercion;
  `stopPlanBySymbol` precompute (self-loaded via `getStopPlans`) threaded into
  `generateProactiveRiskProposals` and `enrichOpeningProposal`; ATR precompute extended to opening
  candidates; `clearStopPlans` call alongside the existing `clearTakeProfitTrimBands` close sweep.
- `src/lib/synthetic-stops.ts` — self-loads `stopPlanBySymbol`; purge-on-"none" pass; registration
  loop honors "trailing" (with fallback %) and skips "none"/excluded symbols.
- `src/lib/broker-protective-stops.ts` — `stopPlanBySymbol` param + `kindForSymbol` per-symbol
  narrowing, applied throughout sections 3 (mismatch/cancel) and 4 (placement).
- `src/lib/account-deletion.ts` — `position_stop_plans` added to `DELETE_TABLES_BY_USER_ID`.
- `app/dashboard-types.ts` / `src/lib/dashboard.ts` — `DashboardSnapshot.stopPlanBySymbol`.
- `app/console/lib/derive.ts` — `deriveProtection` accepts an optional `stopPlan` and annotates.
- `app/console/components/positions.tsx` — wires `snapshot.stopPlanBySymbol` into `deriveProtection`.
- `app/console/components/approval-card.tsx` — shows a fresh non-default `stopPlan` on the card.
- `app/console/guardrails/stop-flow.tsx` — new "Per-position override" 4th lane.
- Tests: `test/strategy-hardening.test.ts`, `test/synthetic-stops.test.ts`,
  `test/broker-protective-stops.test.ts`, `test/position-stop-plans-db.test.ts` (new),
  `test/console-live-data-derive.test.ts`, `test/stop-flow-model.test.ts`.

## Verification

```bash
npx tsc --noEmit      # clean
npm run lint          # 0 errors, 376 pre-existing warnings (grandfathered)
npx vitest run        # 317 files, 3475 tests, all passing
npm run build         # succeeds
```

## Follow-ups

- This branch was stacked on `claude/stop-loss-preset-options-f1jygn` (PR #1331), which received
  Codex review rounds 5-7 while this feature was being built; each round's fix was landed on the
  base branch first (isolated worktree), then merged into this branch (3 merge commits: rounds
  5, 6, 7 — see `git log` on this branch for the exact merge points). This branch's own diff has
  **not yet** been through a Codex review pass — expect one after the PR opens.
- No dedicated unit test for `sanitizeProposals`'s `stopPlan` coercion in isolation — the function
  isn't exported and is exercised indirectly through the enforcement-layer tests above; exporting
  it purely for a unit test was judged out of scope.
- `evaluateTradeProposal`'s lack of a `stopPlan: "none"` gate is a deliberate design choice (see
  "Decisions made"), not an oversight — flagged here so a future reviewer doesn't assume it's
  missing validation.
- Broker-held short trails remain a known follow-up (PR #1331's own follow-up list) — a short
  position's "trailing" plan is honored by the synthetic monitor only, same as the account-wide
  trailing setting.
