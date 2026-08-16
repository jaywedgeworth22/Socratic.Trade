# 2026-08-16 — Overlay CRUD, Polymarket deepening, ASOF receipt

## 1. Context & Objective

Owner decisions after the Monet r5 pickup: (1) build the overlay library fully and expand it; (2) defer weekly hard-delete; (3) no Reddit/X — deepen Polymarket for sector/macro and honest tilts; (4) run the VECTOR_ASOF_STRICT coverage report.

## 2. Changes Made

### Overlays

- Strategy page Overlays card: enable toggle, max-active, starter-template seed, CRUD, regime preview ("Would Fire Now").
- `GET/POST /api/overlays` and `PATCH/DELETE /api/overlays/:id` (user-scoped).
- Four starter templates (Earnings Season, Choppy Tape, Risk-Off, Trend) seed disabled so they do not change behavior until enabled.

### Polymarket

- Curated sector/theme catalog attached from existing `sec`/`ind`.
- Run-level `predictionMarketsMacro` (US recession, Fed, CPI, WTI) next to Kalshi.
- Yes/No percents + labeled tilt from question kind.  No 0-100 score.  Thin books stay neutral.

### ASOF

- Full dry-run receipt: 13,076 / 13,076 epoch'd, 0 undated.  See `docs/rollouts/2026-08-16-asof-strict-coverage.md`.

### Files

- `src/lib/polymarket-signals.ts`, `src/lib/polymarket-provider.ts`, `src/lib/strategy.ts`, `src/lib/strategy-prompts.ts`, `src/lib/source-settings-catalog.ts`
- `src/lib/overlay-templates.ts`, `src/lib/db-overlays.ts`
- `app/api/overlays/route.ts`, `app/api/overlays/[id]/route.ts`, `app/console/strategy/overlays-panel.tsx`, `app/console/strategy/page.tsx`
- Tests listed below
- This note, ASOF receipt, STATUS, PLAN, effort log

## 3. Decisions & Trade-offs

- Weekly hard-delete stays deferred.
- Reddit/X not built.
- Theme queries are curated phrases, not raw industry strings.
- Overlay starters insert disabled.
- Did not flip `VECTOR_ASOF_STRICT`.

## 4. Verification State

Targeted vitest on overlay/polymarket/prompt-safety tests, then land.sh trio.

## 5. Next Steps

- Owner: enable overlays in Strategy → Overlays if wanted.
- Owner: flip `VECTOR_ASOF_STRICT` in Infisical if desired (receipt is clean).
