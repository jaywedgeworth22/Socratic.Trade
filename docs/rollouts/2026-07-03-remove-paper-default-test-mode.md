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
Docs-only (no source touched). `npx tsc --noEmit` clean · `npm run lint` 0 errors · `npm run build`
green. **`npm test`:** initially RED for a **pre-existing, unrelated** reason — today (2026-07-03) is
the observed US July 4 market holiday, so `isTradingDay()` was false and `runStrategyOnce`'s
market-closed guard (`src/lib/strategy.ts:252`) skipped every non-manual run, failing the ~17 strategy /
persistence assertions that expect a run to execute (llm-failover, money-path-f-g,
moneypath-drawdown-flip, rationale-collapse, bear-fail-closed, bull-truncation, persistence-notification,
redteam-observability). Those tests don't mock the calendar, so they were time/holiday-dependent — and
weekends would keep CI red through Mon, blocking #339, the rebrand, and the Step-2 PR.

**Fixed here (2026-07-03), on this same #339 branch, centrally — NOT per-test-file:** `isTradingDay`
now takes an optional date and, for the no-argument "today" call only, returns true when
`AGENTIC_TEST_FORCE_TRADING_DAY=1`. That flag is set ONLY by `vitest.config`'s `test.env`, never in
production; an explicit-date call always uses the real calendar, so `market-hours.test.ts` /
`token-budget-ceiling.test.ts` still assert real closures. This is deliberately **zero test-file
edits** so it does NOT collide with the in-flight Step-2 branch (`claude/remove-paper-test-mode`),
which owns those ~36 test files. Files: `src/lib/market-calendar.ts`, `vitest.config.ts`. Re-verified:
full suite **2365 passed**, tsc clean, lint 0 errors. Step-2 should therefore NOT re-add per-file
`isTradingDay` mocks — the calendar is already deterministic in tests.

## Follow-ups
- Step 2 code removal (tracked; the large piece).
- After removal, re-scan `STATUS.md`/`PLAN.md`/`README`/docs for stale "Test mode"/"paper default"
  language and purge it.
