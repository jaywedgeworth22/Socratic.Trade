# 2026-08-18 — IRA Ignore/Block already existed; they were not wired

## Context & Objective

Owner asked whether a small taxable loss should lock a Roth, then said they thought Ignore / Auto / min-loss already worked that way.  Those options already exist.  This change does not add a third IRA mode.  It fixes the wiring so Ignore, Block, and `washSaleMinLossUsd` do what the settings already say.

## Changes Made

Ignore (`iraWashSaleHandling: "disregard"`, the default) already permitted the buy at the gate.  Green was still told to note a forfeited deduction, and `taxContext` still carried `washSaleRebuyCosts` priced at the raw policy short-term rate (often 24%) even though IRA rates are zeroed.  IRA Block fell through to taxable Auto prompt language.  `washSaleMinLossUsd` was hidden on IRA Guardrails and unused on the IRA buyer path, so a nickle taxable loss could still hard-lock a Roth on Block.

- Gate: a taxable loss below the IRA floor is not a lock (blank = $50; explicit 0 = every loss).
- Prompt `agentic-strategy@2.13.0`: Ignore does not constrain this IRA; Block is material locks only.
- Strategy `taxContext`: Ignore omits lock lists and rebuy costs.  Block gets user-level material symbols (this IRA's own `lockedSymbols` is empty).
- Guardrails shows the existing min-loss field on IRA.  Results copy no longer says every taxable loss locks this IRA.

Touched files:

- `src/lib/defaults.ts` — `DEFAULT_IRA_WASH_SALE_MIN_LOSS_USD = 50`
- `src/lib/policy.ts` — `iraWashSaleMinLossUsd`; IRA buyer path uses the existing floor
- `src/lib/types.ts` — comments only (`block | disregard` unchanged)
- `src/lib/strategy-prompts.ts` — `agentic-strategy@2.13.0`
- `src/lib/strategy.ts` — Ignore omits locks/costs; Block uses material user-level locks
- `app/console/guardrails/page.tsx`, `app/console/guardrails/field-defs.ts`
- `app/console/strategy/tax-settings.tsx`, `app/console/results/page.tsx`
- `app/settings-search.ts`, `app/api/policy/route.ts`
- `ios/SocraticTrade/DeskModels.swift`, `ios/SocraticTrade/GuardrailsView.swift`
- `ios/SocraticTradeTests/DeskModelsTests.swift`
- `test/washsale-modes.test.ts`, `test/run-strategy-offline.test.ts`, `test/strategy-prompt-safety.test.ts`
- `docs/architecture-blueprint.md`, `docs/trading-framework.md`, `docs/phase-7-strategy.md`
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`

## Decisions & Trade-offs

- Did not add `IraWashSaleHandling = "factor"` or `ira_factored`.  Taxable Auto remains the "weigh it yourself" path.  IRA has Ignore vs Block only.
- IRA blank min-loss is $50 so a nickle taxable loss is not a lock.  Taxable blank stays "every loss" (unchanged).  Explicit 0 on an IRA = every loss.
- Ignore still annotates + audits a *material* rebuy (`ira_disregarded`).  A loss below the floor is not a lock and is not annotated.
- iOS remains display-only for these tax fields (existing policy: toggle Block vs Ignore on web).
- No Stripe / IAP.  Did not touch reserved PRs.

## Verification State

Recorded after the commands in this note run.

```bash
npx tsc --noEmit
npx vitest run test/washsale-modes.test.ts test/run-strategy-offline.test.ts test/strategy-prompt-safety.test.ts test/ira-washsale-api.test.ts test/console-policy-diff.test.ts test/settings-search-index.test.ts
npm run lint
```

Full `npm test` on this Cloud VM often hangs on unrelated network files.  `npm run build` follows if the focused gate is green.

## Next Steps & Blockers

- Confirm production Roth `iraWashSaleHandling` is Ignore (default).  If a stale persist left it on Block, a material taxable loss still hard-locks — that is the existing option working.
- No unwind of the earlier NWG harvest sell (harvest prompt already fixed on main).

## Zero-Code Findings

The settings were not missing.  Ignore already proceeded at the gate.  Green + Results + the hidden IRA min-loss field made Ignore and small losses behave like a lock.
