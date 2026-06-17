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
- Latest completed design area in docs: `docs/phase-8-cockpit-ui.md` describes
  the single-screen cockpit UI and Strategy Studio review/apply workflow.
- Cloud branch: `codex/upload-current-state` is pushed to `origin`.
- Draft PR: https://github.com/jaywedgeworth22/robinhood-agentic-trading/pull/2

## Active Focus

- Current publish branch packages the latest dashboard, cockpit UI,
  market-data, strategy, short/cover, and handoff-doc work for review.
- 2026-06-16: completed a cockpit-UI optimization pass (presentation-only) —
  fixed the floating-alert positioning bug (now a bottom-right toast stack),
  added modal/tab accessibility (Escape, focus management, scroll-lock, ARIA),
  extracted ~400 lines of inline styles into CSS classes, and removed dead
  TS/CSS. Verified with `tsc` + `npm test` (80) + `npm run build`. See
  `docs/rollouts/2026-06-16-ui-optimization-pass.md`.
- 2026-06-16: LLM token + learning-loop pass — added an outcome-aware Thesis
  Scorecard (realized win/return/P&L per `tradeThesisTag`) fed to the Bull agent
  and reflection; gated the post-mortem so it only regenerates on new trades
  (saves a call + enables prompt caching); trimmed redundant prompt context
  (allowlist cap, slim recent orders, leaner Bear critique). Then deepened it:
  MAE/MFE excursion timing stats (`getExcursionsByThesis`), regime-conditioned
  outcomes (`getRegimeScorecard`), and delta-only macro pruning (`pruneMacro`).
  Adversarially reviewed (P&L/integration clean; one prompt-wording nit fixed).
  Verified with `tsc` + `npm test` (86) + `npm run build`. See
  `docs/rollouts/2026-06-16-llm-token-and-learning.md`.
- 2026-06-16: bottom drawer (Activity/Runs/Notifications) now has a per-tab
  minimum height (~2 entries) and a discoverable resize grip; content scrolls.
  See the resizable-bottom-drawer section in
  `docs/rollouts/2026-06-16-ui-optimization-pass.md`.
- 2026-06-16 (branch `ui-redesign`): full presentation redesign into a themable
  dark/light "trading terminal" — Tailwind 4 + Recharts + Motion, command bar,
  Portfolio rail + tabbed workspace (Decision/Market/Performance/Strategy),
  feeds as a right slide-over, modal Settings/Strategy Studio, ⌘K palette, and a
  Recharts learning-loop visualization (P&L by thesis/regime). Data/agent layer
  unchanged (snapshot now also carries thesis/regime scorecards). `tsc` + 86
  tests + build pass. See `docs/rollouts/2026-06-16-ui-redesign-tailwind.md`.
  Analyzed `RobinAgent-MCP`: a thin AI-Studio mockup — borrowed UI polish only;
  our agent engine is far ahead.
- 2026-06-16 (branch `ui-redesign`): US tax-mitigation features — wash-sale
  lockout guardrail (policy blocks rebuying a symbol sold at a loss within 30
  days), a Tax tab (ST/LT realized, estimated liability, wash-sale flags,
  tax-loss-harvest candidates, days-to-long-term), after-tax agent context, and
  Tax settings. New `src/lib/tax.ts`. `tsc` + 92 tests + build pass. See
  `docs/rollouts/2026-06-16-tax-mitigation.md`. Estimates only — not tax advice.
- 2026-06-16 (branch `ui-redesign`): signals + learning-loop pass (tractable
  subset of Codex's "Stronger Trading Signals And Learning Loop" research plan).
  Plumbed five already-fetched-but-orphaned fields (`fcfYield`, `debtToEquity`,
  `epsGrowth`, `insiderSentiment`, `senateTrades`) end-to-end into factor scoring
  (`valueScore`/`qualityScore`), the agent prompt, and the Market Scan table
  (FCF% / D/E / EPS gr columns). Constrained `tradeThesisTag` to a fixed 10-tag
  `THESIS_PLAYBOOK` enum on both Bull + Bear schemas. Added Bayesian shrinkage
  (`shrunkWinRate`/`shrunkAvgReturnPct`, 5-trade neutral prior) to the
  thesis/regime scorecards. Added a `candidates_considered` audit logging chosen
  vs top-skipped scan candidates per run for future counterfactual learning.
  `tsc` + 93 tests + build pass. See `docs/rollouts/2026-06-16-signals-learning.md`.
  Deferred to next phase: new providers (Alpha Vantage/FMP/SEC/FINRA/Cboe/FRED/
  Kenneth French), SignalSnapshot/EvidenceDigest layer, thesis×regime×sector×factor
  learning with a 20-lot gate, async digests.
- Near-term engineering focus should be hardening Phase 7/8 before Live use:
  broker support confirmation, persistence/accounting checks, strategy-tuning
  tests, and better tests around short/cover and red-team debate behavior.

## Known Risks

- The worktree may be dirty. Check `git status` before assuming a clean base.
- `short` / `cover` support is partly implemented in policy and paper P&L, but
  Live use still needs broker-surface confirmation and persistence/accounting
  review, especially daily-notional tracking in `src/lib/db.ts`.
- `npx tsc --noEmit` can fail when `.next/types/**/*.ts` entries referenced by
  `tsconfig.json` are missing or stale. A fresh `npm run build` regenerates
  them.
- `npx tsc --noEmit` may report a pre-existing `mockFetcher` type mismatch in
  `test/alternative-data.test.ts` unless that file has been addressed directly.
- `npm run build` regenerates `.next/`; restart any running dev server after it.
- If the browser shows plain unstyled HTML, verify
  `/_next/static/css/app/layout.css` is returning `200`; if it returns `404`,
  restart the dev server on `127.0.0.1:3000`.

## Read This First

1. `AGENTS.md`
2. `STATUS.md`
3. `PLAN.md`
4. Relevant `docs/phase-*.md`
   - `docs/phase-8-cockpit-ui.md` for current dashboard UX architecture
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
