# Status

Current snapshot for fast handoff across Codex, Claude, Cursor, Gemini, or a
human contributor. Update this when active focus, risks, or near-term next
steps materially change.

## Current State

- App: local-only Next.js Robinhood agentic trading dashboard with paper/live
  mode separation, policy gating, equity-only execution, and a phase-based
  design roadmap.
- Roadmap: `PLAN.md` tracks the cross-phase implementation order; `docs/`
  contains the per-phase design details.
- Latest completed design area in docs: `docs/phase-7-strategy.md` adds the AI
  strategy architecture, learning loop, and intended short-selling guardrails.

## Active Focus

- Primary near-term work appears to be market data and strategy plumbing based
  on the latest commits:
  - `5bbe7bd` Update Phase 7 strategy with new data source integrations
  - `37feb31` Close short/cover order-side risk gap and add API keys scaffolding
  - `218b4ab` Merge Phase 7 work (trade-thesis tracking, post-mortem reflection,
    fundamentals fields, dashboard refactor) into main

## Known Risks

- The worktree may be dirty. Check `git status` before assuming a clean base.
- `short` / `cover` support exists at the type/schema level, but any change in
  risk, PnL, or accounting logic should still be checked carefully against the
  guardrail notes in `AGENTS.md` and `docs/phase-7-strategy.md`.
- `npx tsc --noEmit` can fail when `.next/types/**/*.ts` entries referenced by
  `tsconfig.json` are missing or stale. A fresh `npm run build` regenerates
  them.
- `npx tsc --noEmit` may report a pre-existing `mockFetcher` type mismatch in
  `test/alternative-data.test.ts` unless that file has been addressed directly.
- `npm run build` regenerates `.next/`; restart any running dev server after it.

## Read This First

1. `AGENTS.md`
2. `STATUS.md`
3. `PLAN.md`
4. Relevant `docs/phase-*.md`
5. Latest matching file in `docs/rollouts/`
6. `git log -3` and current diff

## Documentation Rules

- Durable repo instructions belong in `AGENTS.md`.
- Current snapshot belongs here.
- Feature design and architecture belong in `docs/*.md`.
- Chronological implementation notes belong in `docs/rollouts/`.
- Every non-trivial change should leave either a rollout note or an updated
  existing one if the work is part of the same rollout.

## Next Update Triggers

Update this file when any of the following change:

- active implementation focus
- highest-risk known issue
- expected verification workflow
- handoff reading order
- roadmap meaningfully changes
