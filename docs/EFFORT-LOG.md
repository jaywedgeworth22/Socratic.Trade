# Effort Log — cross-agent board

**Canonical live board:** `/Users/jay/apps/TRADING-EFFORT-LOG.md`

This repo file is the tracked mirror for commits/PRs. Update the canonical live board first so
agents in other worktrees can see reservations before code lands, then mirror relevant state here
before committing.

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

_As of 2026-07-04. PR numbers are GitHub `jaywedgeworth22/agentic-trading`._

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
- **2026-07-03** — `trading-live` published at `0941b4d2` (PR #349) on
  `socratictrade.com`. Includes Socratic admin/RAG/Pinecone/settings parity,
  provider-specific model reasoning controls, OAuth host canonicalization,
  `/old`, ticker drawer coverage, and user/admin LLM usage visibility. Production
  health 200 and Google/GitHub OAuth redirect URIs verified on the Socratic domain.
- **2026-07-03** — `trading-live` published at `afbe1c87` (PR #352) on
  `socratictrade.com`. Includes RAG provider/quota Sentry visibility, Pinecone-hosted
  embedding-model documentation, Infisical Socratic.Trade slug documentation, and
  production health 200 after deployment.
- **2026-07-04** — `trading-live` published at `d39e1193` (PR #353) on
  `socratictrade.com`. Includes explicit `Test Account - Local Mock Paper Account`
  restore and Pinecone/Voyage/provider cap email alerts; production health 200 after
  deployment.
- **2026-07-04** — `trading-live` contains `94669873` (PR #442) and current
  production HEAD `1e1a15bc` on `socratictrade.com`. Includes the Codex
  console/UI swimlane: approval provenance/citations, mobile LIVE phrase parity,
  Sheet focus trap, read-only decision trace, ticker drawer parity, and Strategy
  custom-model select parity. Verified Deploy workflow success, PM2 `trading`
  online, `/api/health` 200, and built route/page artifacts present under
  `.next/server/app`.
- **2026-07-04** — `trading-live` published at `1e1a15bc` (PR #444) on
  `socratictrade.com`. Includes the tokenless public HTTPS
  `congress-trading-shared` dependency path; production health 200 after
  deployment.

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
- **#348** — Sell to Fund Buys title-case copy fix (`codex/sell-to-fund-title-case`):
  Guardrails and legacy dashboard Sell to Fund Buys labels/options now use Title Case, and the
  Guardrails save-review diff shows Title Case instead of raw lowercase enum values.
- **#349** — Socratic admin/RAG/Pinecone/settings parity implementation
  (`codex/live-thesis-portfolio-framing`): default RAG index `socratic-trade`, Pinecone/Voyage
  health visibility, RAG ingestion brakes, provider-specific model reasoning controls, `/old`,
  OAuth host canonicalization, ticker drawer coverage, and user/admin LLM usage visibility.
- **#350** — AI Review inheritance, model catalog, and text-box font controls
  (`codex/ai-review-model-inheritance`): removed the misleading account-review model fallback,
  made blank AI Review inherit Red Team then Green Team, refreshed current curated provider model
  options, added DeepSeek V4 thinking controls, and made console text boxes use consistent readable
  fonts with user-selectable examples.
- **#351** — Console actions/evidence/live-account polish + RAG quota safeguards
  (`codex/console-actions-evidence-live`): action history/blocker copy, stopped cadence display,
  raw-vs-benchmark return tooltips, reduced live-account warning copy, broker roadmap, RAG usage
  labeling, Pinecone estimated Write Unit fuse, and earnings/RAG design docs.
- **#352** — RAG Sentry visibility + Pinecone hosted-model review
  (`codex/rag-sentry-visibility`): Sentry warning/error events for RAG provider failures and
  budget trips, Pinecone-hosted NVIDIA/MSFT embedding options documented as benchmark candidates,
  and Infisical project naming recorded as `Socratic.Trade` / `socratic-trade`.
- **#353** — Test Account restore + usage cap email alerts
  (`codex/restore-test-account-option`): explicit addable local mock Test Account that is not
  default-selected, plus Pinecone/Voyage/provider cap trips routed through `budget_alert` with
  email-capable fallback.

### Fleet observability (2026-07-04)
- **#371** — Additive Sentry CI failure reporter (`claude/sentry-ci-observability`), fleet-wide
  observability half (b). New `.github/workflows/sentry-ci-report.yml` +
  `scripts/sentry-ci-report.py`, zero edits to any pre-existing workflow: on
  `workflow_run: types:[completed]` across all 7 workflows that existed at authoring time,
  failure conclusion sends a raw-envelope Sentry error event to the `fleet-infra` Sentry project
  tagged `{workflow, branch, actor}` and fingerprinted `[workflow, branch]`; schedule-triggered
  runs additionally send a Sentry Crons check-in mirroring that workflow's own cron so a
  nightly/weekly job that silently stops running also alerts. Repo secret `SENTRY_FLEET_DSN` set
  via `gh secret set` (value never echoed/logged). Companion host-side monitor
  (`fleet-sentry-monitor` under pm2, machine-side, not in this repo) covers pm2 crash-loop/down
  detection, disk/WAL space, and `gh` rate-limit budget — see
  `docs/rollouts/2026-07-04-fleet-sentry-observability.md` for full detail on both halves.
- **PR #374 — GitHub Issues mirror of the effort board (`claude/effort-issues-mirror`).**
  Additive, read-only owner-visibility layer over `docs/EFFORT-LOG.md`: boards stay the single
  source of truth, agents never write issues — a workflow reconciles them. New
  `scripts/sync-effort-issues.py` (python3 stdlib, no deps) parses the board (keyword-classified
  `##` sections tolerant of heading/emoji drift, top-level bullets as items with continuation
  lines folded in, `<!-- effort-key: sha1(first-line) -->` identity marker for idempotent
  re-runs). Planned/In Progress -> issue open (`effort-board` + `state:planned`/`state:in-progress`,
  assigned `jaywedgeworth22` for mobile notifications); Completed/Deployed -> issue closed
  (`state:completed`/`state:deployed`). Never deletes issues; ignores hand-made issues without the
  marker; creates missing labels on first run. New additive workflow
  `.github/workflows/effort-issues-sync.yml` (push to `main` touching this file, daily off-minute
  cron for drift, `workflow_dispatch`). Rolled out identically to `congress-trading-shared` (PR #4)
  and `API-usage-monitor` (PR #9); canonical protocol doc
  (`/Users/jay/apps/EFFORT-LOG-PROTOCOL.md`) gained an "Issues mirror (standard)" subsection +
  bootstrap-checklist update. Verified: parser tested directly against all three repos' real
  boards before rollout (58/1/2 items respectively, correct bucketing); a genuine duplicate board
  row surfaced by a live dry-run (this repo's own "Wave-1 quick wins..." logged twice under In
  Progress) was caught and fixed with in-run dedup; full local quartet green (lint 0 errors, tsc
  clean, 2436 tests, build ok); post-merge the push-triggered workflow run created all 58 issues
  correctly bucketed (32 completed/6 deployed closed, 9 in-progress/11 planned open), confirmed via
  the Issues API. See `docs/rollouts/2026-07-04-effort-issues-mirror.md`.

---

## 🔨 In Progress

- **Regime-enum adoption inside the risk gates** (MONET risk lane, branch
  `claude/regime-enum-risk-gates`, isolated worktree `nice-heyrovsky-b9d0bd`) — **PR open**. The
  three deterministic risk gates now classify the persisted regime label through the shared typed
  `MarketRegime` source of truth (`market-regime.ts`) instead of three independent
  substring/`startsWith` rules: crisis/inverted opening-exposure cap (`policy.ts`
  `isCrisisOrInvertedRegime`), bear-filter risk-off veto (`strategy.ts` `deterministicBearFilter` —
  the site whose in-code comment reserved the conversion for the risk lane), and the escalation gate
  (`regime-watch.ts` `isEscalationRegime`, also feeding `strategy.ts`'s dissent trigger). This is the
  "one-line adoption" the w1-regime-data lane (#368) exported the typed predicates and pinned
  `test/market-regime.test.ts` for. Correctness hardening only — canonical-label behavior is
  byte-identical (a relabel can no longer silently desync one gate from another); the one intended
  change is that a non-canonical free-text label now reads non-escalating rather than accidentally
  substring-matching. Imports from `./market-regime` (not `./macro`) so the whole-module macro mock
  in `test/regime-watch.test.ts` still exercises the real classifier. New gate-level regression
  `test/regime-gate-adoption.test.ts` (+ a `policy.test.ts` hardening case). Gate green: tsc clean,
  lint 0 errors, 254 files/2465 tests, build ok. See
  `docs/rollouts/2026-07-04-regime-enum-risk-gate-adoption.md`.
  _2026-07-04 (CLAUDE): PR #449 merged to `main` (`c3553ebb`) — row ready to move to Completed on
  Monet's next pass; noted here rather than moved, per never-move-another-agent's-row etiquette._

- **Wave-2 composite-review — Outcome Engine lane** (Claude, branch `claude/w2-outcome-engine`,
  worktree `~/apps/trading-wt-w2-outcome`, based on `claude/w1-learning-loops`) — four §A items:
  (1) THE OUTCOME WRITER: new scheduled job `src/lib/outcome-engine.ts` on the counterfactual
  cadence; placed decisions join fill_events/closed lots, blocked/rejected (incl. Bear vetoes)
  join counterfactual refPrice; writes `outcome`+`measuredAt`, per-case receipt, awaited
  vector-memory re-index. (2) Multi-horizon outcome schema `outcomes[] {15m|1h|1d|1w, returnPct,
  spyExcessPct, priceBasis, resolution ok|unresolvable(reason)}` on decision cases AND
  skipped-counterfactual rows; 1d/1w from the daily cascade SPY-relative (trading-day
  arithmetic); 15m/1h only via an actually-sampled live quote, else honest
  `unresolvable(no_intraday_source)`. (3) Kill-survivorship: terminal `unresolvable` after a
  bounded 10-trading-day recheck; coverage disclosures on job receipts, `getRedTeamEfficacy`,
  missed-opportunity summary, `certifyForwardResolution`. (4) Budget-gated, batch-capped LLM
  post-mortem lessons at maturation (direction-tagged + verdictOnBelief/whichDissentMattered),
  routed through `ingestLearned` origin `autonomous`; all skips receipted. Gate green: lint 0
  errors, tsc clean, 2383 tests / 246 files, build green. **Pushed; NO PR — lands via the
  landing train after the base branch.** See `docs/rollouts/2026-07-04-w2-outcome-engine.md`.


- **`claude/ci-actions-efficiency` (Claude, worktree `~/apps/trading-wt-ci-efficiency`) → PR #370.**
  GitHub Actions minutes efficiency pass — personal Pro-plan quota (3,000 min/mo) was exhausted.
  `.github/workflows/ci.yml`: new cheap `classify` job computes on `pull_request` events whether
  the diff (`git diff --name-only base...head`) touches ONLY documentation-class paths (`*.md`
  anywhere, `docs/**`); the existing `verify` job (unchanged name — confirmed via
  `gh api repos/jaywedgeworth22/agentic-trading/rulesets/17945518` that `verify` is the ONLY
  required status check today, not smoke/gitleaks/check-pin as the AGENTS.md fallback list
  assumes) now step-conditionally skips checkout/install/lint/tsc/test/build when
  `docs-only == 'true'` and reports success immediately; any non-PR event or diff ambiguity falls
  back to the full gate.
  **Mid-review addition:** repo hit its 10 GB Actions-cache cap because a plain `actions/cache@v4`
  save (source-hash-keyed) wrote a new ~340 MB `.next` entry on every PR push with no cleanup on
  close, plus unbounded growth on `main`. Fixed via restore/save split
  (`actions/cache/restore@v4` always, `actions/cache/save@v4` gated to `main` pushes only) plus
  new `.github/workflows/cleanup-caches.yml` (PR-close cache delete + daily prune backstop via new
  `scripts/prune-stale-actions-caches.py`; not a required check).
  **Escalated, then re-confirmed during review:** hybrid self-hosted/hosted runner routing for
  `verify` onto the production `trading-live-mac` box was proposed; escalated back with
  objections (reverses the repo's own 2026-07-01 decision to move `verify` OFF that runner; a
  required check should not depend on which of two OS/toolchain environments executed it); the
  owner then re-confirmed AFTER seeing the tradeoff, with a resource-aware design answering each
  objection (availability publisher w/ load+RAM+hysteresis, instant hosted fallback on
  busy/stale, hosted-Linux arbiter on any self failure via exactly-one automatic hosted re-run,
  nightly hosted canary, per-run environment annotation) — to be built as its OWN PR after #370
  lands (see Planned row below). A cross-repo `workflow_call` reusable entry point stays deferred
  until that hybrid PR proves itself; hosted-only default when built. Neither implemented in this
  branch. **Codex review round:** two fail-open holes fixed (`--no-renames` rename-source hole;
  classify-failure skip hole via `!cancelled()` + explicit fail-closed step).
  No other workflow modified besides the two above — full audit table (every push/PR-triggered
  workflow, approx minutes, required-check status, batching candidates) in
  `docs/rollouts/2026-07-04-ci-actions-efficiency.md`, report-only for those other workflows.
  Verification: local quartet green (lint 0 errors, tsc clean, 2436/2436 tests, build ok) +
  `yaml-lint` on all workflow files + live ruleset API check + dry-run of the cache-delete command
  + synthetic-inventory test of the prune script. STATUS: implemented, PR #370 open; CI/Smoke/
  Security observed running live on the PR during review, so Actions quota is not currently
  blocking (contrary to the initial task assumption of exhaustion).

- **Wave-1 quick wins from the composite expert review** (Claude coordinator, 4 Sonnet lanes,
  push-only branches; landing via the active train):
  - `claude/w1-llm-fixes` — Bear schema confidenceScore fix (live bug); non-OpenAI reasoning-token
    headroom; cross-family Bear default + temperature; reward-abstention; stakes-scaled dissent
    trigger. **Merged** (PR #364).
  - `claude/w1-learning-loops` — Bear-veto counterfactuals + red-team efficacy scorecard; re-index
    decision memory on lifecycle changes; trading-day horizon arithmetic. **Merged** (PR #365).
  - `claude/w1-rag-quickwins` — relevance floor + near-dup dedupe wired; provenance headers + stable
    chunk ids; content-hash dedup on + 128-bit; embedding-model version tag; rerank pool cap.
    **Merged** (PR #366).
  - `claude/w1-regime-data` — landing now that gate is green. Typed `MarketRegime` enum + numeric
    severity in new dependency-free `src/lib/market-regime.ts` (re-exported from `macro.ts`;
    `determineMarketRegime` now a thin label-projection, byte-identical persisted strings).
    **Swimlane keepout:** the crisis cap (`policy.ts`) and bear filter (`strategy.ts`) deliberately
    KEEP their original substring/`startsWith` checks — per the owner-assigned Fable/Monet swimlane
    split (`#claude-monet-sync` sync·2), enum adoption inside risk-gate call sites belongs to the
    risk lane (Monet, PR #360); the typed predicates are exported and pinned by
    `test/market-regime.test.ts` for a one-line adoption there. The console regime card
    (`app/console/macro/indicators.ts`) does use the enum (client-safe, zero server-only imports).
    Live ^VIX overlay (`fetchLiveVix`/`fetchMacroDataWithLiveVix`, 10 min TTL, separate from the 24h
    macro cache) now feeds the vol brake and the regime-flip detector instead of the day-cached
    snapshot. `alpacaSnapshotTtlMs()` (~30s) replaces the blanket 6h TTL for the Alpaca snapshot
    enrichment cache, and `parseAlpacaSnapshot` now stamps `asOf` from `latestTrade.t`/`dailyBar.t`
    so the `maxQuoteAgeSec` staleness gate can see true quote age. Verified: lint 0 errors, tsc
    clean, 247 files / 2401 tests green, build green. See
    `docs/rollouts/2026-07-04-regime-enum-live-vix-alpaca-asof.md`.

- **Wash-sale gate — non-blocking defaults** (`claude/washsale-advisory-defaults`, Claude,
  **merged**, PR #362). Owner decision: `taxSettings.washSaleHandling` default
  `"block"` → `"auto"`; `taxSettings.iraWashSaleHandling` default `"block"` → `"disregard"`.
  Mid-task correction: "auto" no longer vetoes on a deterministic edge-vs-tax-cost threshold at
  all (removed as pseudo-math — it re-arithmetized the LLM's own confidence/target outputs); it
  now always proceeds, with the priced tax cost recorded on the receipt and threaded into the
  strategist prompt instead. `block`/`ask` remain valid opt-ins; receipt/annotation/audit
  machinery unchanged. Verified: lint 0 errors, tsc clean, targeted suite 218/218, full suite
  2352 passed / 17 failed (all 17 in the 8 pre-existing holiday-broken files), build green.
  See `docs/rollouts/2026-07-03-washsale-advisory-defaults.md`. **2026-07-04 (Fable):** Added 
  #agent-sync channel & protocol documentation (docs-only, separate branch `claude/agent-sync-protocol-docs`).

- **Console small fixes (t7/t18/t22/t39)** — branch `claude/console-small-fixes`, **merged** (PR #361).
  Scope: reusable `RawNumInput` component (fixes
  the "0."-input-collapse bug) applied at 4 numeric-input sites; `MARKET_REGIME_LABELS` persisted-
  contract const + test coverage for `determineMarketRegime`; account-deletion scope preview now
  warns about discarded pending learned-context items; `notify.bridge.error` ops-feed formatter.
  See `docs/rollouts/2026-07-03-console-small-fixes.md`.

- **Controlled RAG filing ingest smoke test** (Codex,
  `/Users/jay/apps/trading-codex`, branch `codex/rag-filing-ingest-smoke-fix`) — production verified
  against the new `socratic-trade` Pinecone index. One MSFT 10-Q now has 95 vectors and 95 local
  `document_chunks`; the timed-out first-run 56 duplicate vectors were removed. Code fix for
  deterministic SEC filing vector ids is implemented and awaiting PR.

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
  NOTE: built before the decision-record correction landed (decision #1 is ADVISORY, not hard-halt —
  see Owner decisions below). **RE-SCOPED (2026-07-04, Monet):** see the row below.

- **Drawdown breaker → ADVISORY default (re-scope of #343)** (Monet, cloud, branch
  `claude/drawdown-advisory-rescope`) — owner reassigned this lane to Monet (swap: Fable → memory/RAG,
  Monet → risk engine; coordinated on Slack `#claude-monet-sync`). Reverts the mistaken hard-halt default
  to the owner's actual philosophy ("nothing is hard except which account to work in; agent decides, logs
  everything"): `drawdownBreakerAction` now `"advisory" | "close_only" | "halt"`, **default `"advisory"`** —
  on breach it writes a receipt + threads `drawdownAdvisory` into the strategist prompt (agent decides),
  NO `systemState` change; `close_only`/`halt` are explicit opt-ins. tsc/lint/2375 tests/build green.
  **PR pending.** Follow-up: advisory into the Bear context; broader per-gate sweep → owner questions first.

- **Expert design review — 147-finding improvement backlog** (Monet, cloud, branch
  `claude/expert-design-review`) — an 8-expert agent panel (ML/learning, RAG/embeddings, LLM-prompting,
  quant/risk, data-providers, data-ingestion, UI/UX, ML-systems) + synthesis produced
  `docs/reviews/2026-07-04-expert-design-review.md`: 147 prioritized improvements across memory/learning,
  LLM prompting, RAG/ingestion, data providers, decision-making, UI, and systems, each with a concrete
  approach + `[impact/effort]`; cross-cutting-gaps section; quick-wins/big-bets tables; Now/Next/Later
  roadmap. Docs-only. **PR pending.** (Read section E through the ADVISORY-guardrails correction above.)

- **Wave-1 composite-review quick wins — memory & learning-loop lane** (Claude, branch
  `claude/w1-learning-loops`, **merged**) — three items from the composite
  expert review (§A, lines 37-161):
  (1) Bear-veto counterfactuals: a Red Team veto now calls `recordRejectedProposalCounterfactual`
  (same pipeline as policy blocks/human rejections) in `strategy.ts`'s Bear-reject branch, stamped
  with `runId`+`model`; new `getRedTeamEfficacy()` in `performance.ts` joins matured vetoed-candidate
  returns to `proposal_rejected_by_red_team` audit events for rejection rate / veto value-add /
  survivor-risk hit rate / per-model breakdown — API/db-level only, no console/Results UI wiring
  (left for the console lane). (2) Re-index decision memory: `appendSocraticDecisionCoachNote` now
  re-calls `indexSocraticDecisionMemory` after the coach-note append (dynamic import avoids a
  `db-socratic -> socratic-memory -> vector-db -> ./db` cycle); the stable id/dedupKeyPrefix makes it
  an in-place upsert. (Outcome/lesson writers don't exist yet in this codebase — a separate,
  unassigned effort — so only the coach-note lifecycle path was wired.) (3) Trading-day horizon
  arithmetic: new `addTradingDays()` in `market-calendar.ts` (honors `isTradingDay`, walks weekends
  + holidays) replaces the calendar-ms arithmetic in `counterfactual-learning.ts` and `backtest.ts`'s
  `targetBusinessDate`, fixing weekday-dependent horizon noise; historical target dates for
  Thu/Fri-snapshotted candidates shift (one-time discontinuity, snapshot-tested). Verification green:
  lint 0 errors, tsc clean, **2377 tests / 245 files**, build green. See
  `docs/rollouts/2026-07-04-w1-learning-loops.md`.

- **Wave-2 memory/RAG core** (Claude/Fable coordinator — OWNER-ASSIGNED swimlane; lanes stacked on
  their w1 dependency branches, push-only, landing via the train). Lanes: `outcome-engine`,
  `episodic-retrieval`, `coaching-durable`, `reflection-decompose` (full lane list on the live board
  `/Users/jay/apps/TRADING-EFFORT-LOG.md`).
  - `claude/w2-episodic-retrieval` (this lane) — **done, pushed, awaiting the landing train** (base:
    `origin/claude/w1-rag-quickwins`). Composite review A1 ([Both], the highest-leverage item): new
    `src/lib/experience-memory.ts` — closed-lot experience writer hooked fire-and-forget in
    `performance.recordFillFromProposal` (state vector: 8 factor sub-scores + entryMarketRegime +
    breadth snapshot + thesisTag + sector + entry rationale; realized
    `{return_pct, holding_days, risk_exit, mae?, mfe?}` metadata; `source="experience-memory"`
    namespace keyed by the ENTRY proposalId); decision-time SECOND retrieval pass over
    `['socratic-decision','coach-note','lesson']` with a situation-sketch query (cross-symbol via
    additive `RetrieveOptions.matchAllSymbols`, same-run exclusion, as-of stamped); labeled
    "Closest historical analogs" (+`[COUNTEREXAMPLE]` on opposite-sign priors, top-analog
    similarity shown) + "Owner coaching" blocks injected into BOTH Bull and Bear userContent;
    injected ids persisted per run (`experience_retrieval` audit + rag attributions). Opt-out
    `EXPERIENCE_MEMORY=off`. Verify green: lint 0 errors, tsc clean, **2395/2395 tests**, build
    green. See `docs/rollouts/2026-07-04-w2-episodic-retrieval.md`.

---

## ✅ Owner decisions (2026-07-03) — sovereign-design + housekeeping

1. **Drawdown circuit-breakers → ADVISORY** _(CORRECTED later on 2026-07-03 — the "HARD-HALT" record
   was wrong; the owner didn't understand the question as originally asked)._ Confirmed intent, in the
   owner's words: **"nothing is hard except which account to work in."** A drawdown breach is an
   advisory input the agent weighs with its own judgment; it may proceed, and every deviation surfaces
   as a logged receipt for review and coaching. The same philosophy governs ALL guardrail lines (spend
   caps, sizing, etc.) — the **account boundary is the only absolute**. Confirmed option: "Agent
   decides, logs everything." See `docs/rollouts/2026-07-03-guardrail-philosophy-correction.md`.
   ~~Was recorded as: HARD-HALT — a drawdown breach halts autonomous trading until manually re-armed.~~
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

- **Hybrid resource-aware runner routing for `verify` (Claude, own PR after #370 lands) —
  RESERVED 2026-07-04, owner re-confirmed with design.** Route the required `verify` check to the
  self-hosted Mac runner ONLY when the Mac has spare capacity, hosted otherwise. Design (per
  owner, answering the objections raised when this was first proposed): (1) Mac-side
  `scripts/runner-availability.sh` under pm2 (owner-started; pm2 one-liner + idempotent setup
  note in the PR) — every 60s: available = 1-min loadavg/hw.ncpu < 0.6 AND free+inactive RAM
  > 6 GB AND runner process alive AND pm2 `trading` online; hysteresis 2 consecutive available
  checks before flipping to self, immediate flip to hosted on busy; publishes repo variable
  `VERIFY_RUNNER_STATE` as JSON {"mode","ts"}; self-path gate commands run under `nice -n 19`.
  (2) Router reads `vars.VERIFY_RUNNER_STATE` natively; mode!=self OR ts stale >5 min OR var
  absent -> hosted instantly (self-hosted concurrency-1 stays as a load-shed detail). (3)
  verify-self FAILURE triggers exactly one automatic hosted re-run and the gate takes the hosted
  result on disagreement (Linux arbiter — a Mac flake can never block or fake-fail a merge); a
  self PASS stands; nightly scheduled hosted full-gate canary on main; gate summary annotates
  which environment produced each result. macOS-ARM64 cache namespace; node presence fail-fast;
  smoke/gitleaks/check-pin stay hosted. Rollout doc must include the 2026-07-01 history, the
  objections, the owner's re-confirmation + resource-aware answer, and a failure-mode table.
  `workflow_call`/reusable (cross-repo) remains deferred until this lands and proves itself —
  hosted-only default stands; resource-aware routing stays opt-in per repo.

### Socratic console parity sub-lanes — reserved before implementation
- **Universal ticker detail drawer parity** — restore old-site discoverability by making ticker symbols
  open the shared drilldown/drawer consistently across scan, home, evidence cards, proposals, orders,
  and other console surfaces. Reserved under the broader Codex parity effort so parallel agents do not
  start a duplicate ticker-detail lane. Initial high-signal gaps covered by `codex/console-ui-swimlane`;
  new console surfaces should default to `SymbolButton` for actionable tickers.
  _2026-07-04 assignment: CODEX._
- **Settings affordance and tooltip pass** — add clearer option descriptions/tooltips, replace confusing
  loose/tight wording with lock/unlock-style affordances, and turn absolute-vs-percent pairs into a
  polished mode switch where the pair represents alternative ways to express one constraint.
  _2026-07-04 assignment: CODEX._
- **Model/provider control parity** — move strategy model controls toward curated dropdowns with
  provider-aware settings, showing reasoning controls only for models that actually support them.
  Initial Strategy custom-model selected-state parity covered by `codex/console-ui-swimlane`.
  _2026-07-04 assignment: CODEX._
- **Admin connection health and backend-failure notification pass** — surface every backend dependency
  including Pinecone/Voyage, distinguish global backend failures from user-key failures, and route
  global failures to admin email/health while user-key failures become user notifications.
  _2026-07-04 assignment: AG (Antigravity), incl. a per-provider failure-injection test proving global-vs-user-key routing._

### Ready to build — decisions in
- **Live-execution hardening (next major build).** Now unblocked by decisions 1–2:
  - **Advisory drawdown awareness (corrected target)** — surface the breach state to the agent
    (prompt context) and to the owner (receipt/notification + coaching trail); NO halting.
    _(Corrected from "hard-halt" — see Owner decisions above.)_
  - **Hard-halt drawdown circuit-breakers** — ✅ built (merged as #343, branch
    `claude/live-execution-hardening`): `riskRules.drawdownBreakerAction` default `"halt"` flips the
    breaker to `systemState → "halted"` on breach until manually re-armed; overridable to `"close_only"`.
    NOTE: built before the decision-record correction landed; re-scope pending owner review.
  - **Prompt-expected stop-losses** — REMAINING: strengthen the strategist prompt + schema to expect a
    stop on opening proposals, with policy validation (NOT a schema hard-requirement, per owner).
    _2026-07-04 assignment: MONET (risk lane)._
  - Build/test against a **connected broker account** (paper or live); the removed local Test mode /
    `paperMode` default is gone (#342). Keep the existing typed-confirm ritual before any live toggle.
- **Manager-model A/B** — wire the shortlisted models via the OpenAI-compatible path (base-URL swap;
  DeepSeek/xAI/Qwen/Gemini) + the existing Anthropic path, run in paper mode, compare per-model Results.
  See `docs/manager-model-options.md`.
  _2026-07-04 assignment: CLAUDE._

### Planned — actionable, not yet started
- **Per-model hit rates on Results** — now that `proposedByModel` persists (#334), surface realized
  win/return grouped by served model. _(Directly enables the Manager-model A/B above.)_
  _2026-07-04 assignment: CODEX (Results UI; joins `proposedByModel` + `getRedTeamEfficacy`)._
- **Per-field FRED sourcing** — a partially-failing FRED fetch still placeholder-fills individual
  series while the suite is flagged sourced; close with per-series flags (#326/#334 follow-up).
  _2026-07-04 assignment: AG (Antigravity)._
- **SSE for the learned-context inbox** — replace the 60s poll if the console gains an event stream.
  _2026-07-04 assignment: CODEX (fold into the console live-data build-out row below)._
- **`MarketQuoteSummary` factor bars for all scanned symbols** — #335 carried factor fields into the
  summary tier; confirm drilldown factor bars now populate for every scanned symbol, not just top candidates.
  _2026-07-04 assignment: CURSOR (DeepSeek)._

### 2026-07-04 backlog exhaustiveness pass — promoted items with assigned lanes
_Owner-directed promotion of every still-open review-doc item into individually tracked rows.
Sources: `docs/reviews/2026-06-30-improvement-audit.md` (11-expert audit), the two 2026-07-04
expert/composite reviews, `docs/reviews/2026-07-03-console-parity-open-items.md`, `PLAN.md`, and a
code sweep. Assignment tags: CURSOR = Cursor background agents (DeepSeek v4 Pro), CODEX = Codex,
AG = Antigravity/Gemini, MONET = Claude Monet (Opus, risk lane), CLAUDE = Claude Code (memory/RAG
lane). Unassigned rows await an owner decision or scheduling. Assignments are reservations, not
locks — re-negotiate in #agent-sync._

#### CURSOR (DeepSeek v4 Pro) lane
- **Rate-limit `/api/chat` and `/api/scan` (CURSOR, S)** — apply the existing rate-limiter to both
  routes; cost-exhaustion vector when operator LLM fallback is enabled. (improvement-audit S-1)
- **Encrypt Robinhood OAuth tokens at rest (CURSOR, S)** — `setMcpOAuthTokens` bypasses the
  `encryptValue` path used for other stored secrets. (improvement-audit S-2)
- **Constant-time admin token comparison (CURSOR, S)** — `src/lib/auth/admin.ts` compares with
  `===`; switch to `timingSafeEqual`. (improvement-audit S-3)
- **Security response headers (CURSOR, S)** — add CSP / X-Frame-Options / Referrer-Policy via
  middleware. (improvement-audit S-5)
- **Delete dead Anthropic branch in `resolveLlmEndpoint` (CURSOR, S)** — unreachable code +
  wrong provider tag in `llm-provider.ts`. (improvement-audit §4)
- **Code-split StrategyFlow and the price chart (CURSOR, M)** — `next/dynamic({ssr:false})` for
  `@xyflow/react` (~3.9MB first-load win). (improvement-audit §3.10)
- **Synthetic bid/ask provenance fix (CURSOR, S)** — drop or tag `yahoo-finance-synthetic` bid/ask
  in `toQuoteOnlyMarketQuote` and exclude it from `hasAskData` so limit-price math never anchors on
  fabricated spreads. (improvement-audit §3.5)
- **`daysToEarnings` enrichment field (CURSOR, S)** — earnings-calendar wiring through the full
  per-field sourcing chain (see the AGENTS.md enrichment trap). (improvement-audit §4)
- **`institutionOwnership` enrichment field (CURSOR, S)** — already-authenticated Yahoo
  quoteSummary module. (improvement-audit §4)
- **Adopt `EmptyState`/skeleton primitives on dashboard empty states (CURSOR, S)** — primitives
  exist but are unused. (improvement-audit §4)
- **Voyage query-embedding LRU cache (CURSOR, S)** — cache repeated query embeddings; est. 50-80%
  query-embed cost cut. (improvement-audit completeness §D)
- **Account-deletion table-list drift guard (CURSOR, S)** — a test that fails when a new `db-*`
  table is missing from the deletion scope. (improvement-audit completeness §F)
- **Global symbol omnibox (CURSOR, S)** — type any ticker anywhere to open the drilldown drawer.
  (expert reviews quick-wins)
- **Scheduler single-leader ON in prod + `/api/health` hard threshold (CURSOR, S)** — currently
  opt-in. (improvement-audit A-5)
- **Global operator LLM spend ceiling + unpriced-model default price (CURSOR, S)** — operator-wide
  ceiling distinct from per-user budgets; unknown model ids get a conservative default price so
  cost never silently undercounts. (expert reviews quick-wins)
- **Effort-mirror orphan report (CURSOR, S)** — periodic report of mirror issues orphaned by
  reworded board rows so they don't accumulate open forever. (issues-mirror rollout follow-up)
- **Litestream restore drill + PITR retention config (CURSOR, S)** — actually exercise a restore;
  make the retention window configurable. (completeness §F + quick-wins)

#### CODEX lane (adds to the annotated parity rows above)
- **Scan table column customization parity (CODEX, M)** — visibility/ordering/reset/saved state vs
  the legacy dashboard. (console-parity-open-items)
- **Approvals triage upgrades + alert center (CODEX, M)** — bulk actions, sort/filter, and a
  console alert center. (expert reviews)
- **Console live-data build-out (CODEX, L)** — SSE wiring + mark-to-market, positions blotter
  streaming, live risk-utilization board, intraday charts (lightweight-charts adoption). Subsumes
  the SSE learned-context-inbox row above. (expert reviews)
- **`/console/settings` second IA pass (CODEX, M)** — account identity/authority/keys/
  notifications/admin-links reorg. (console-parity-open-items)
- **Coach chat → framework primitives (CODEX, M)** — attach note to decision, promote lesson, show
  consuming run; framework `rewrite` verb + ownerResponse. (console-parity + composite review)
- **Accessible tooltip/popover primitive everywhere (CODEX, S)** — retire native `title`;
  universal coverage across controls/metrics/cells. (expert reviews + console-parity)

#### AG (Antigravity/Gemini) lane
- **Eliminate redundant fill-history fetch/replay (AG, M)** — fills fetched/replayed 7-9x per
  request; fetch once and thread through. (improvement-audit §3.7)
- **Wire congress-score-eval go/no-go into scan scoring (AG, M)** — the most rigorous evaluator
  currently has no production consumer. (improvement-audit §3.8)
- **Robinhood option-chain IV / put-call enrichment (AG, M)** — wire the connected MCP option
  tools for near-the-money IV + put/call ratio. (improvement-audit §6.7)
- **E2E money-path integration test (AG, M)** — mock LLM+broker through `runStrategyOnce`
  proposal→evaluate→execute→record. (improvement-audit A-2)
- **Concurrency/property/fault-injection test suite (AG, M)** — target the single-writer SQLite
  hazard and crash-mid-write paths. (expert reviews cross-cutting)
- **Horizon-matched multi-horizon IC in the factor tuner (AG, M)** — IC currently fixed at 5-day
  vs multi-week theses. (expert reviews cross-cutting)
- **Congress push/SSE contract repair (AG, M, cross-app)** — App A pushes a shape App B never
  accepts; the push path is dead today. Paired row on the Congress.Trade board. (PLAN
  Integrations + improvement-audit §6.8)

#### MONET (Opus, risk lane)
_(A sixth row — typed regime-enum adoption in the risk gates — was drafted here but Monet already
shipped it as PR #449 while this pass was being written; see its In Progress row above.)_
- **Bear/Red-Team unavailable → policy-aware routing for ALL failure modes (MONET, M)** — complete
  the mode-aware policy (propose→human-approval; autonomous→de-risk-only + "RED TEAM FAILED" flag)
  across timeout/429/malformed-JSON, replacing the remaining fail-open paths. (improvement-audit
  §3.1 + the recorded Red-Team policy decisions)
- **Volatility-targeting sizing + portfolio-heat budget (MONET, L)** — continuous exposure taper
  instead of binary caps; advisory-style and owner-overridable per the guardrail philosophy.
  (expert reviews big-bets)
- **Correlation gate + event blackouts + pre-trade stress scenario (MONET, M)** — EWMA/downside
  correlation, earnings/macro-event blackout windows, scenario stress on proposals — all advisory
  receipts, never cages. (expert reviews)
- **Fractional-Kelly sizing on realized payoff (MONET, M)** — downside-dispersion-aware; aligns
  sizing with realized edge. (expert reviews cross-cutting)
- **Multi-signal regime scorer (MONET, M)** — credit spreads, VIX term structure, breadth →
  severity feeding caps/learning. (expert reviews critical-path)

#### CLAUDE lane (memory/RAG + already-reserved infra)
- **Wire `usage-budget` Phase-2 enforcement into `runStrategyOnce` (CLAUDE, M)** —
  `evaluateBudgetForRun`/`cheaperModel` are built and tested but never called; flagship
  "built-but-unwired" item. (code sweep)
- **RAG retrieval-quality eval harness (CLAUDE, M)** — 25-40 golden query→expected-chunk tuples +
  vitest recall@k/MRR scorer. (improvement-audit §3.4)
- **Bull/Bear prompt eval + versioning harness (CLAUDE, L)** — offline eval + PROMPT_VERSION
  discipline for the money-path prompts. (improvement-audit §3.3)
- **HyDE + evidence-derived multi-query retrieval (CLAUDE, M)** — retrieval-quality upgrade.
  (expert reviews)
- **Durable due-jobs substrate (CLAUDE, M)** — sub-day outcome sampling that survives process
  downtime; explicitly deferred from w2-outcome-engine. (expert reviews critical-path)
- **Per-user/day token-budget ceiling at trigger/strategy entry (CLAUDE, M)** — enforcement
  deferred in `triggers.ts`; per-user policy caps replace env-only config. (completeness §D)

#### Unassigned — owner decision or scheduling needed
- **Split `strategy.ts` god-module (unassigned, L)** — 2,902 lines → proposal-generation/
  execution/reconciliation/learning modules (db.ts split precedent). High merge-conflict surface —
  schedule in a quiet window. (improvement-audit A-1)
- **Repository layer + write-queue over SQLite (unassigned, L)** — both expert reviews sequence
  this BEFORE more write-heavy features; Postgres option, per-provider quota buckets,
  SQLite-backed enrichment cache. (cross-cutting)
- **Factor-weight learning auto-apply (unassigned, L, needs owner sign-off)** — scheduled cadence
  → OOS gate → clamp → persist, opt-in flag. (improvement-audit §3.6)
- **Overlap-aware IC SE + Deflated-Sharpe/PBO on auto-apply gates (unassigned, L)** — statistical
  honesty before any learning loop auto-applies. (expert reviews)
- **CPCV multi-fold + point-in-time universe for backtests (unassigned, L)** — survivorship fix.
  (expert reviews big-bets)
- **Joint portfolio construction over the batch (unassigned, L)** — cluster/diversify/allocate as
  a true Manager step. (expert reviews big-bets)
- **Active hedging / net-exposure reduction on vol brake (unassigned, L)** — protect the existing
  book, not just stop entries. (expert reviews big-bets)
- **Earnings-transcript + news point-in-time ingestion (unassigned, L)** — fill the dead doc_types
  retrieval already asks for. (expert reviews)
- **Groundedness/faithfulness advisory gate (unassigned, M)** — flags ungrounded claims into the
  approval inbox (shared strategy+chat). (expert reviews cross-cutting)
- **End-to-end point-in-time leakage certificate (unassigned, M)** — certifies no data class
  leaked hindsight into an auto-apply gate. (expert reviews cross-cutting)
- **Tamper-evident audit chain (unassigned, L)** — make receipts unforgeable. (expert reviews)
- **Model/prompt registry + promotion gate + input-drift monitor (unassigned, L)** — ops maturity
  for model swaps. (expert reviews)
- **Decision-bundle persistence + replay substrate (unassigned, M)** — seeds + run-level Langfuse
  trace tree + online eval sampler. (expert reviews)
- **Multi-user fill streaming (unassigned, M)** — the Alpaca trade-updates stream is
  operator-only today (`alpaca-trade-updates-stream.ts`). (code sweep)
- **`admin.socratictrade.com` dedicated admin host (unassigned, M)** — DNS/routing/middleware
  split. (console-parity-open-items)

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
- 2026-07-03 — Made `docs/EFFORT-LOG.md` maintenance explicitly binding at start/handoff/commit/PR/
  merge/deploy boundaries in `AGENTS.md`. Started the broader Socratic admin/RAG/Pinecone/settings
  parity implementation in Codex branch `codex/live-thesis-portfolio-framing`.
- 2026-07-03 — Tightened the `AGENTS.md` EFFORT-LOG rule: every non-trivial effort gets a **Planned**
  row before substantial work starts, specifically to stop parallel agents/platforms from duplicating
  the same lane.
- 2026-07-03 — **#347 merged + deployed** (→ Completed / Deployed): console Universe index
  exclusivity fix at `481e9dcc`; production health and live S&P/Nasdaq mutual-exclusion behavior
  verified. Started `codex/sell-to-fund-title-case` to title-case the Sell to Fund Buys selector
  labels/options and save-review summary.
- 2026-07-03 — **#350 merged** (→ Completed): AI Review inheritance/model catalog/text-box font
  controls. Started `codex/console-actions-evidence-live` for the owner-requested console polish
  covering Actions, cadence, returns, IRA wash-sale behavior, Evidence/source labels, LLM settings
  usage affordances, LIVE-warning reduction, broker-option investigation, provider/model naming
  consistency, and repo/folder rename planning.
- 2026-07-03 — **CORRECTION:** "drawdown=hard-halt" was mis-recorded (the owner didn't understand the
  question). Owner confirmed: guardrails are ADVISORY — agent decides, logs everything; the account
  boundary is the only hard rule. Decision 1 + the hardening scope updated accordingly. #343's
  hard-halt breaker was built off the wrong record before this correction landed; re-scope pending
  owner review. See `docs/rollouts/2026-07-03-guardrail-philosophy-correction.md`.
- 2026-07-04 — **Backlog exhaustiveness + assignment pass (CLAUDE, owner-directed).** Promoted every
  still-open item from the review docs/PLAN/code-sweep into individually tracked Planned rows with
  assigned lanes (CURSOR/DeepSeek large slate, CODEX + AG medium slates, MONET risk slate, CLAUDE
  memory/RAG slate, unassigned owner-decision bucket); annotated the pre-existing Planned rows with
  assignments (in row bodies, not first lines, to preserve mirror issue identity). Also deduped the
  twice-logged "Wave-1 quick wins" In Progress row (the issues-mirror dry-run had flagged it) — the
  removed copy's detail lives in PRs #364/#365/#366/#368 and their rollout notes. See
  `docs/rollouts/2026-07-04-backlog-exhaustiveness-assignments.md`.
