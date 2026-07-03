# 2026-07-03 — Remove paper-as-default + Test mode (owner directive)

## Summary
Owner directive, repeated and emphatic: this is a **real trading app**, the owner accepts 100% risk,
and the paper-mode reverence + local "Test mode" simulator must go — along with any "protect the
owner's money from agent bugs" paternalism. This lane executes it in two steps.

**Step 1 (this commit — rules, the root cause):** `AGENTS.md` (== `CLAUDE.md` symlink) rewritten:
- Deleted the Don't-rule *"Don't place real trades or toggle `paperMode:false` while testing — Paper
  mode is the default for a reason."*
- Deleted the *"defaults to Test mode (a local SQLite simulator)"* framing; clarified `DATABASE_URL` /
  `data/app.db` is app **infrastructure** (settings/proposals/users), not a fake execution mode.
- Added a top **"Product philosophy — real trading, owner's risk"** section: an account is an account
  (a broker paper account is just a connected account by `environment`, not a safe-mode); no
  Test-mode/local-sim; don't protect the owner from accepted risk; **harden CORRECTNESS + multi-user
  safety, NOT obedience** — guardrails are the owner's overridable preferences (the
  `iraWashSaleHandling: "disregard"` setting is the template), never an immovable cage or a scolding
  ritual.

This is the root-cause fix: the paper/test paternalism was encoded in the agent rules themselves, so
every tool (Claude, Codex, …) kept re-imposing it. Deleting the rule stops the loop.

**Step 2 (in progress — code, separate PR):** remove the execution-layer implementation:
- `src/lib/execution-mode.ts` — `deriveExecutionState` currently returns `test/local`
  (`usesLocalSimulation: true`) whenever `policy.paperMode` is set OR no account is connected. Collapse
  to: account present ⇒ `broker/paper` | `broker/live` by `account.environment`; no account ⇒ the app
  cannot place orders (no local-sim fallback). Drop `usesLocalSimulation` / the `test/local` mode / the
  `Test` label / mock theme.
- Cascade: `strategy.ts` (the `usesLocalSimulation` paper-fill branch + `getPaperPortfolioProjection`),
  `dashboard.ts` (local portfolio projection), `preflight-live-guard.ts`, `defaults.ts` (`paperMode`
  default), `db-profiles`, `synthetic-stops`, `tax`, `scheduler`, `mobile-api`, and the `paperMode`
  policy field.
- ~36 test files rely on Test mode to run without a broker — rewrite them onto a connected test/mock
  broker account (`TestBrokerGateway`) so the suite still runs. Keep `DATABASE_URL`/temp-DB (infra).
- Land in coherent, individually-green pieces (money-path; not one reckless bang).

## Why
The owner has said this for weeks. The behavior persisted because it was baked into the agent rules
and the execution layer. Fixing the rules stops re-imposition; removing the code delivers the actual
product change (the app trades through a real broker connection, paper or live, with no fake mode).

## Files (Step 1)
- `AGENTS.md` (philosophy section + deleted rules), `STATUS.md`, `docs/EFFORT-LOG.md`,
  `docs/rollouts/2026-07-03-remove-paper-default-test-mode.md`.

## Verification (Step 1)
Docs-only. `npx tsc --noEmit` clean · `npm run lint` 0 errors · `npm run build` green (test suite
unchanged — no source touched in Step 1).

## Follow-ups
- Step 2 code removal (tracked; the large piece).
- After removal, re-scan `STATUS.md`/`PLAN.md`/`README`/docs for stale "Test mode"/"paper default"
  language and purge it.
