# Effort Log — cross-agent board

The owner's at-a-glance ledger of every effort and its state. **Every agent on every platform
(Claude Code, Codex, Antigravity/Gemini, Cursor, web/cloud sessions) MUST keep this current** as
part of the Pre-Commit / Handoff Protocol in `AGENTS.md`. Move each row between the four states as
it changes; add new efforts as they are conceived; never delete another agent's row — correct it
in place and note the correction.

**State definitions**
- **Planned** — agreed/queued, not started. Include blockers (esp. "needs owner decision").
- **In Progress** — actively being built; carry a one-line status + the owning agent/branch.
- **Completed** — merged to `main`. This auto-deploys to **beta/integration only**
  (`trading-beta.jays.services`), NOT production.
- **Deployed to production** — the separate **owner-run** release step (`~/apps/trading-live`,
  pm2 `trading`, release branch). Cloud/agent sessions cannot perform or verify this — only move a
  row here when the owner (or a release runner) confirms the production deploy actually happened.

_As of 2026-07-03. PR numbers are GitHub `jaywedgeworth22/agentic-trading`._

---

## 🚀 Deployed to production

_Owner-managed release; not verifiable from cloud/agent sessions. When the owner promotes `main`
to `socratictrade.com`, record the release commit + date here._

- **2026-07-02 (evening)** — `trading-live` observed at `eae514be` (post-#338) on the
  deploy machine. **Incident:** the deploy boot-crashed on the pre-existing prod DB
  (`no such column: client_turn_id`, Sentry `a595484d…`, release `8e2b1181` = #333);
  `/api/health` 500 with pm2 crash-looping. **Recovered 2026-07-03 ~01:50 CDT** by
  backing up the DB and applying the migration's own additive `ALTER`, then restart —
  health 200. Root cause + regression test in the P0 hotfix row below; full detail in
  `docs/rollouts/2026-07-03-clientturnid-migration-hotfix.md`.
- **2026-07-03** — `trading-live` published at `7b803bff` (PR #346) on
  `socratictrade.com`. Includes #345 run-state UX and #346 IRA wash-sale UI correction;
  production health 200 and live Roth IRA Settings page verified.
- **2026-07-03** — `trading-live` published at `481e9dcc` (PR #347) on
  `socratictrade.com`. Includes the Guardrails Universe index exclusivity fix;
  production health 200 and live S&P/Nasdaq mutual-exclusion UI behavior verified.

---

## ✅ Completed (merged to `main`, on beta/integration)

### Console parity port — legacy `app/ui/*` rebuilt as `/console` (2026-07-02)
- **#321** — parity-port foundation: logo/model/drilldown primitives, nav scaffolding, model-attribution approval card.
- **#322** — Settings expansions: brokers, API keys, LLM model picker, delivery channels, glossary.
- **#324** — Learned-context approval inbox on `/console/approvals`.
- **#325** — AI Assistant chat destination (`/console/assistant`) → staged proposals. _(incl. coordinator round-2 fixes: ref-during-render lint, image-exfil block, preview-race generation guard, frozen staged scope.)_
- **#326** — Macro & market-regime board (`/console/macro`) + honest no-FRED handling (`fredSourced`).
- **#327** — Scan destination: Market Scan table + Smart Money.
- **#328** — Orders destination: open orders, stale-limit detection, replace-at-market, cancel.
- **#329** — Parity tail: run-blocked routing, sign-out, allocation, watchlist+alerts, consent gate, sharing prefs, account deletion, admin links, badge fold-in.
- **#330** — Symbol drilldown superset of the legacy company drawer.

### Real-money / tax gate (2026-07-02)
- **#323** — Wash-sale handling modes (`block`/`ask`/`auto`) + Decide-mode escalation framework. _(incl. coordinator round-2: account tax-type precedence, in-run cap demotion, `transitionProposalIfPending` CAS.)_
- **#331** — IRA wash-sale disregard setting (`taxSettings.iraWashSaleHandling`), owner-requested. Default `block` (unchanged); `disregard` proceeds annotated ("Wash Sale (Technically, but IRA purchase unreported to IRS)") + audited. _(incl. coordinator Codex round-1: prompt threading via `isIraTaxRegime`, deferred disregard audit to execution, `decision.approved` gate.)_

### Backend follow-ups (2026-07-02, landed by parallel sessions)
- **#332** — `@sentry/nextjs` bump to ^10.63.0 + short/cover risk-path semantics clarification.
- **#333** — Chat idempotency: `clientTurnId` retry dedupe on `POST /api/chat` (migration v10).
- **#334** — Persist failover-aware `proposedByModel` per proposal; blank (never fabricate) no-FRED macro (`DEFAULT_MACRO`→`BLANK_MACRO`, `pruneMacro` drops `""`).
- **#335** — `EquityOrder` limit/stop/TIF through Alpaca+Robinhood mappers + `/console/orders` columns; disclosure-ordered congress cap; `MarketQuoteSummary` factor/headlines/volume fields; Turbopack dev fix.
- **#336** — `sources.price` provenance in `mergeQuoteData` (merged broker/Yahoo price now attributed to the merge provider, not the stale screener) + this cross-agent effort log.
- **#337** — Owner decisions record + `docs/manager-model-options.md` (cross-provider model comparison for the strategist role).

### P0 hotfix (2026-07-03)
- **#341** (`claude/fix-baseddl-index-migration`) — boot crash on every pre-existing DB: #333's baseline-DDL
  `idx_chat_turns_user_client` ran before the versioned ALTER (`no such column` on old DBs; fresh-DB CI
  stayed green). Baseline reverted to frozen `SCHEMA_BASELINE`; versioned migration is the single source;
  regression test boots `getDb()` against a simulated pre-#333 DB. Prod/preview DBs already hand-patched
  (see Deployed section).

### Rebrand (2026-07-03)
- **#340** — Rebrand Agentic Trading → **Socratic Trade** / socratictrade.com (`claude/rebrand-socratic-trade`).
  Owner set up prod infra as "Socratic Trade" (Sentry project, Cloudflare DNS, GitHub OAuth callbacks,
  Google authorized domains — owner-side). Code aligned: display brand → "Socratic Trade" (no-space
  "Socratic.Trade"); legacy production host fallback → `socratictrade.com` (env-first);
  Sentry slug → `socratic-trade`; active telemetry/notify/MCP/FINRA/account-deletion fallback identifiers
  now use Socratic Trade naming. Deliberately NOT touched: `mail@jays.services` login email, the Robinhood
  "Agentic" account nickname, internal jays.services preview subdomains.

### De-paternalization + CI hardening (2026-07-03)
- **#339** — De-paternalize Step 1: deleted the paper-default / `paperMode:false` Don't-rule + the
  "defaults to Test mode" framing from `AGENTS.md`; added the "Product philosophy — real trading,
  owner's risk" section (an account is an account; no Test-mode/local-sim; harden CORRECTNESS +
  multi-user safety, NOT obedience). Also fixed the July-4 CI holiday flake (`isTradingDay` VITEST-gated
  test seam, so `verify` stops going red on market-closed days) and purged the contradicting Cursor
  rule (`.cursor/rules/handoff.mdc`). _(incl. coordinator Codex round: VITEST gate on the seam so a
  stray flag can't defeat the real market-closed guard; Cursor-rule rewrite; EFFORT-LOG stale-bullet
  supersede.)_
- **#342** — De-paternalize Step 2: removed `policy.paperMode`/`paperStartingCash` and the `test/local`
  local-simulator execution path entirely (`usesLocalSimulation`, `getPaperPortfolioProjection`, local
  paper-fill/portfolio branches). `deriveExecutionState` (`execution-mode.ts`) is the sole hub — mode is
  purely `broker/paper`/`broker/live` from the active account's `environment`; no account ⇒ honest
  "No account" state (`submitsBrokerOrders: false`), never a fake-fill fallback. `TestBrokerGateway`/
  `broker:"test"` kept as test infrastructure only (~36 test files migrated to a connected test-broker
  account). Fixed a real bug: broker-paper fills were mislabeled "Test" in the Activity feed. 83 files,
  +854/−1208.

### Socratic autonomy UI/runtime (2026-07-03)
- **#344** — Socratic Trade Autonomy Desk implementation (`codex/socratic-trade-autonomy-mockup`):
  persisted Socratic decisions/framework proposals, `/api/socratic/*`, RAG attribution, coach notes,
  framework proposal review, strategy-loop decision recording, private institutional-memory indexing,
  Socratic override semantics for owner-preference gates, public `/welcome` and `/how-it-works`,
  coded `/design/socratic-trade`, and exact production-domain references changed to
  `socratictrade.com`.
- **#345** — Run-state UX fix (`codex/run-state-ux-fix`): Start/Resume are no longer hidden behind a
  red STOP affordance. Paused states show Start or Resume as the primary header action; STOP/Wind down
  remain red, and start/autonomy confirm flows use primary styling.
- **#346** — IRA wash-sale UI correction (`codex/ira-washsale-ui-fix`): Roth/traditional IRA accounts
  show same-account IRA wash sales as ignored/not applicable, hide the taxable Block / Ask / Auto
  selector, and expose only the cross-account IRA taxable-loss rebuy setting.
- **#347** — Console universe index exclusivity fix (`codex/universe-exclusive-indexes`):
  `/console/guardrails` now uses the shared `toggleIncludedIndex` helper for Base indices, so
  S&P 100/S&P 500 and Nasdaq 100/Nasdaq Composite replace each other immediately in the draft.

---

## 🔨 In Progress

- **Sell to Fund Buys title-case copy fix** (Codex, local, branch
  `codex/sell-to-fund-title-case`) — Guardrails and legacy dashboard Sell to Fund Buys labels/options
  now use Title Case, and the Guardrails save-review diff shows Title Case instead of raw lowercase
  enum values. Full local gate and Codex preview UI verification are green; PR pending. See
  `docs/rollouts/2026-07-03-sell-to-fund-title-case.md`.

- **Live-execution hardening — drawdown breaker → hard-halt** (coordinator, cloud, branch
  `claude/live-execution-hardening`) — first slice of the hardening build; implements owner decision #1.
  The account-level drawdown/daily-loss breaker now **hard-halts** on breach (`systemState → "halted"`:
  subsequent scheduled runs skip, manual `executeProposal` refuses, until the owner re-arms to
  `"active"`) instead of the softer `close_only`. Built as the owner's **overridable preference**
  `riskRules.drawdownBreakerAction: "halt" | "close_only"` (default `"halt"`), not a hardcoded cage; the
  breaker is still opt-in via the thresholds. Vol-panic brake stays `close_only` (out of scope of the
  drawdown decision). Verified current-run safety (in-run exec uses `placeEquityOrder`, not the
  halted-throwing `executeProposal`; policy gate treats halted==close_only for the current run, so it
  winds down gracefully). Gate green: tsc clean, lint 0 errors, **2351 tests / 239 files**, build green.
  **PR pending.** Remaining hardening half — prompt-expected stop-losses (decision #2) — is a separate
  follow-up. See `docs/rollouts/2026-07-03-drawdown-hard-halt.md`.

---

## ✅ Owner decisions (2026-07-03) — sovereign-design + housekeeping

1. **Drawdown circuit-breakers → HARD-HALT.** During the live soak, a drawdown breach halts autonomous
   trading until manually re-armed. _(Unblocks the hardening build.)_
2. **Stop-losses → PROMPT-EXPECTED.** The LLM proposes stops and policy validates; NOT schema-forced.
   _(Owner chose the more flexible option over the fail-closed default.)_
3. **Manager model tier → EVALUATE cross-provider, not a single pick.** Owner wants a list of options
   (incl. DeepSeek for cost) and to measure how each performs — see `docs/manager-model-options.md`.
   Recommended path: A/B Sonnet 5 / DeepSeek V4 Pro / GPT-5.5-or-Gemini-3.1-Pro in paper mode and rank
   by realized per-model P&L (now measurable via #334's `proposedByModel`). Budget: $25–200/mo covers a
   single model at ~20 runs/day; ~$300/mo covers a 3-model A/B.
4. **Draft #315 → CLOSED** (superseded by the console port).

---

## 📋 Planned

### Ready to build — decisions in
- **Live-execution hardening (next major build).** Now unblocked by decisions 1–2:
  - **Hard-halt drawdown circuit-breakers** — ✅ built (In Progress → PR pending, branch
    `claude/live-execution-hardening`): `riskRules.drawdownBreakerAction` default `"halt"` flips the
    breaker to `systemState → "halted"` on breach until manually re-armed; overridable to `"close_only"`.
  - **Prompt-expected stop-losses** — REMAINING: strengthen the strategist prompt + schema to expect a
    stop on opening proposals, with policy validation (NOT a schema hard-requirement, per owner).
  - Build/test against a **connected broker account** (paper or live); the removed local Test mode /
    `paperMode` default is gone (#342). Keep the existing typed-confirm ritual before any live toggle.
- **Manager-model A/B** — wire the shortlisted models via the OpenAI-compatible path (base-URL swap;
  DeepSeek/xAI/Qwen/Gemini) + the existing Anthropic path, run in paper mode, compare per-model Results.
  See `docs/manager-model-options.md`.

### Planned — actionable, not yet started
- **Per-model hit rates on Results** — now that `proposedByModel` persists (#334), surface realized
  win/return grouped by served model. _(Directly enables the Manager-model A/B above.)_
- **Per-field FRED sourcing** — a partially-failing FRED fetch still placeholder-fills individual
  series while the suite is flagged sourced; close with per-series flags (#326/#334 follow-up).
- **SSE for the learned-context inbox** — replace the 60s poll if the console gains an event stream.
- **`MarketQuoteSummary` factor bars for all scanned symbols** — #335 carried factor fields into the
  summary tier; confirm drilldown factor bars now populate for every scanned symbol, not just top candidates.

---

## Changelog of this log
- 2026-07-03 — Created (coordinator). Seeded from the 2026-07-02 landings (#321–#335) + the
  in-progress `sources.price` fix + blocked sovereign-design decisions.
- 2026-07-03 — #336 merged (→ Completed). Recorded the four owner decisions (drawdown=hard-halt,
  stops=prompt-expected, Manager=cross-provider A/B, #315 closed). Live-execution hardening moved
  Blocked → Ready. Added `docs/manager-model-options.md`.
- 2026-07-03 — #337 merged (→ Completed). In Progress now empty; next work is the Ready items
  (live-execution hardening + Manager-model A/B).
- 2026-07-03 — Added the CI holiday-flake fix (In Progress → on #339) after `verify` went red on the
  observed July 4 closure; fixed via a `vitest.config` `test.env` seam in `isTradingDay`, zero test-file
  edits so it won't collide with the paperMode-removal branch.
- 2026-07-03 — **#339 merged** (→ Completed): de-paternalize Step 1 rules + CI holiday-flake fix +
  Cursor-rule purge (incl. Codex round: VITEST-gated seam, Cursor rewrite). In Progress now = Step 2
  paperMode/test-mode runtime removal + the Socratic Trade rebrand.
- 2026-07-03 — Started the **Socratic Trade rebrand** (branch `claude/rebrand-socratic-trade`): brand
  "Agentic Trading" → "Socratic Trade", public host fallback → `socratictrade.com`, Sentry slug →
  `socratic-trade`; login email + internal machine slugs + Robinhood "Agentic" nickname untouched.
- 2026-07-03 — **#340 rebrand merged** (→ Completed) and **#341 DB P0 hotfix merged** (→ Completed).
- 2026-07-03 — De-paternalize **Step 2 code-complete** (branch `claude/remove-paper-test-mode`):
  `policy.paperMode` + the `test/local` local-simulator execution path fully removed across ~35 src +
  36 test files; rebased on `origin/main` (#340 + #341); gate green (tsc/lint/2350 tests/build); PR
  opened, still In Progress until merged.
- 2026-07-03 — **#342 merged** (→ Completed): paperMode/Test-mode runtime removal. Started
  **live-execution hardening slice 1** (branch `claude/live-execution-hardening`): drawdown breaker →
  hard-halt via overridable `riskRules.drawdownBreakerAction` (default `"halt"`); gate green
  (tsc/lint/2351 tests/build); PR pending. Remaining: prompt-expected stop-losses (decision #2).
- 2026-07-03 — **#344 merged** (→ Completed): Socratic Trade autonomy UI/runtime implementation.
  Started the run-state UX fix (`codex/run-state-ux-fix`) so Start/Resume is no longer hidden behind
  a red STOP control and start flows do not use danger-red styling.
- 2026-07-03 — **#345 merged** (→ Completed): run-state UX fix. Started the IRA wash-sale UI
  correction (`codex/ira-washsale-ui-fix`) so Roth/traditional IRA settings do not present taxable
  Block / Ask / Auto as the relevant same-account wash-sale control.
- 2026-07-03 — **#346 merged + deployed** (→ Completed / Deployed): IRA wash-sale UI correction at
  `7b803bff`; production health and Roth IRA Settings UI verified. Started
  `codex/universe-exclusive-indexes` to restore mutually-exclusive full-overlap index selection in the
  console Guardrails universe picker.
- 2026-07-03 — **#347 merged + deployed** (→ Completed / Deployed): console Universe index
  exclusivity fix at `481e9dcc`; production health and live S&P/Nasdaq mutual-exclusion behavior
  verified. Started `codex/sell-to-fund-title-case` to title-case the Sell to Fund Buys selector
  labels/options and save-review summary.
