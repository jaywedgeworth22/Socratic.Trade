# Trading Effort Log - canonical live cross-agent board

This is the branch-neutral live coordination board for Socratic Trade work across
Claude Code, Codex, Antigravity/Gemini, Cursor, web/cloud sessions, and manual
operator edits.

Canonical location:

`/Users/jay/apps/TRADING-EFFORT-LOG.md`

Tracked mirror in the repo:

`docs/EFFORT-LOG.md`

Rules:
- Every non-trivial effort must be logged here as Planned before substantial work begins.
- Move active work to In Progress before substantial edits.
- Move to Completed only after merge to `main`.
- Move to Deployed only after production at `socratictrade.com` is actually released and verified.
- Never delete another agent's row. Correct in place and note the correction.
- When committing, also update the repo-tracked mirror at `docs/EFFORT-LOG.md`.

State definitions:
- Planned: agreed or reserved, not started.
- In Progress: actively being built; include owner/worktree/branch and one-line status.
- Completed: merged to `main`; beta/integration only unless separately deployed.
- Deployed: released to production (`socratictrade.com`) and verified.

As of 2026-07-04.

---

## Deployed

- 2026-07-04 - Documentation update: added durable naming notes to `AGENTS.md`,
  `/Users/jay/apps/README.md`, and `docs/EFFORT-LOG.md` that
  `Socratic.Trade` is canonical and `Socratic.Trading` is a typo/mistake; also
  corrected the remaining stale `git -C ~/Code/Agentic\ Trading ...` worktree
  command in `/Users/jay/apps/README.md`.
- 2026-07-04 - Ops correction: renamed the main Code-folder worktree from the
  mistaken intermediate `/Users/jay/Code/Socratic.Trading` to the intended
  `/Users/jay/Code/Socratic.Trade`, repaired Git linked-worktree metadata,
  recreated and saved PM2 `trading-main` from the corrected path, verified
  local 4001 and production health, and updated active coordination path
  references in `AGENTS.md` and `/Users/jay/apps/README.md`.
- 2026-07-04 - Ops cleanup: deleted the stray `robinhood-agentic` Pinecone
  index from the new Pinecone account; verified Infisical still exports
  `PINECONE_INDEX_NAME=socratic-trade` and Pinecone now lists only
  `socratic-trade` with 95 vectors. Renamed the main Code-folder project
  worktree from `/Users/jay/Code/Agentic Trading` to
  `/Users/jay/Code/Socratic.Trade`, repaired Git linked-worktree metadata
  including nested `.claude/worktrees`, recreated `trading-main` from the new
  path via `scripts/infisical-run.mjs`, saved PM2, and verified local 4001
  health plus production `socratictrade.com` health. Updated the active
  coordination path references in `AGENTS.md` and `/Users/jay/apps/README.md`.
- 2026-07-04 - Ops mitigation: investigated stray `robinhood-agentic`
  Pinecone index in the new account. It contains 16 SEC 8-K vectors, not
  Robinhood trade/account data, and was consistent with a stale worktree using
  the old `robinhood-agentic` fallback while pointed at the new Pinecone key.
  Added Infisical prod `PINECONE_INDEX_NAME=socratic-trade`, restarted
  `trading`, `trading-main`, and `trading-codex`, verified main/Codex preview
  envs are pinned, production health is 200, and Pinecone counts at the time
  were `robinhood-agentic=16`, `socratic-trade=95` before the later cleanup.
- 2026-07-04 - Ops rotation: `ADMIN_REINDEX_TOKEN` added to the
  Socratic.Trade Infisical prod app project (`socratic-trade`), production
  `trading` PM2 process restarted, and `/api/admin/reindex-10k` verified as
  gated: no identity -> 401, identity without token -> 403, identity plus token
  -> 200 against Pinecone index `socratic-trade` with 95 vectors. Token value
  was not committed or logged.
- 2026-07-04 - `trading-live` published at `d39e1193` (PR #353) on
  `socratictrade.com`; production health 200; explicit local mock Test Account
  can be added without becoming the default account, and Pinecone/Voyage/provider
  cap trips now route through `budget_alert` with email-capable fallback.
- 2026-07-04 - `trading-live` published at `a017624a` (PR #354) on
  `socratictrade.com`; production health 200; new Pinecone `socratic-trade`
  index verified at 95 MSFT 10-Q vectors with matching local chunk ledger, and
  SEC filing ingest now uses deterministic vector ids for retry safety.
- 2026-07-03 - Ops rotation: Pinecone key replaced in Infisical prod and local
  preview env files (`trading-claude`, `trading-codex`, `trading-antigravity`);
  explicit RAG/Pinecone write fuses set in Infisical and preview envs; production,
  Codex, and Claude PM2 processes restarted; new Pinecone account has empty
  `socratic-trade` cosine/1024 serverless index (`vectors:0`). Key value was not
  committed or logged. `trading-main` PM2 env also refreshed through Infisical
  without touching tracked files in the dirty integration checkout.
- 2026-07-03 - `trading-live` published at `afbe1c87` (PR #352) on
  `socratictrade.com`; production health 200; RAG provider/quota failures now
  emit Sentry events when `SENTRY_DSN` is set, Pinecone-hosted NVIDIA/MSFT
  embeddings are documented as benchmark candidates, and Infisical current
  project naming is `Socratic.Trade` / `socratic-trade`. Fresh Pinecone key was
  not committed or logged.
- 2026-07-03 - `trading-live` published at `0941b4d2` (PR #349) on
  `socratictrade.com`; production health 200, Google/GitHub OAuth redirect URIs
  verified on the Socratic domain, and Codex preview synced back to main.
- 2026-07-03 - `trading-live` published at `481e9dcc` (PR #347) on
  `socratictrade.com`; production health 200 and S&P/Nasdaq mutual-exclusion UI
  behavior verified.
- 2026-07-03 - `trading-live` published at `7b803bff` (PR #346) on
  `socratictrade.com`; production health 200 and live Roth IRA Settings page verified.

## Completed

- **PR #374 - GitHub Issues mirror of the effort board (Claude, sonnet lane), cross-app.**
  Merged 2026-07-04. Additive, read-only owner-visibility layer over docs/EFFORT-LOG.md: boards
  stay the single source of truth, agents never write issues — a new workflow reconciles them.
  scripts/sync-effort-issues.py (python3 stdlib, no deps) parses the board (keyword-classified
  sections tolerant of heading/emoji drift, top-level bullets as items, SHA1-of-first-line
  identity marker for idempotent re-runs); Planned/In Progress -> issue open
  (effort-board + state:planned|state:in-progress, assigned jaywedgeworth22 for mobile
  notifications), Completed/Deployed -> issue closed. New .github/workflows/effort-issues-sync.yml
  (push to main touching the board file, daily off-minute cron, workflow_dispatch). Rolled out
  identically to congress-trading-shared (PR #4) and API-usage-monitor (PR #9); protocol doc
  (/Users/jay/apps/EFFORT-LOG-PROTOCOL.md) gained an "Issues mirror (standard)" subsection +
  bootstrap-checklist update. Verified: parser tested against all three repos' real boards before
  rollout; a genuine duplicate board row (this repo's own "Wave-1 quick wins..." logged twice
  under In Progress) was caught by a live dry-run and fixed with in-run dedup; full quartet green;
  post-merge first sync created 58 Socratic.Trade issues (32 completed/6 deployed closed, 9
  in-progress/11 planned open), 2 open issues in congress-trading-shared, 3 open issues in
  API-usage-monitor — all confirmed via the Issues API. See
  docs/rollouts/2026-07-04-effort-issues-mirror.md.
- **PR #371 - Fleet-wide Sentry observability (Claude, sonnet lane).** Merged 2026-07-04
  (`120968725f7e58f383917aafe5c63ec8cfcd10d0`), CI `verify` green. Sentry project `fleet-infra`
  (org jays-services). (a) `/Users/jay/apps/fleet-sentry-monitor/monitor.py` registered under pm2
  (`fleet-sentry-monitor`, `pm2 save`d, machine-side, not in this repo) — pm2 crash-loop (restart
  delta >= 5/interval, hourly-deduped fingerprints) + down detection (error for
  `trading`/`trading-main`, warning otherwise), disk free (<20GB warn/<8GB error) + known SQLite
  WAL >512MB warning, Claude.app presence/RSS (context only), `gh api rate_limit` <300 remaining
  warning, self-hosted runner status (context only), self check-in to Sentry Crons monitor
  `fleet-host-monitor` (interval 2min, margin 5, max_runtime 2, America/Chicago). Verified: two
  live pm2-driven passes completed check-ins ("ok"), a synthetic restart-delta test correctly
  fired the crash-loop error, and the real `gh` rate-limit warning fired live (fleet burned
  graphql to 0 during testing). Note: another agent has since continued iterating on
  `monitor.py` in place (adding per-app agent/app tags, Codex session breadcrumbs) — see the
  Codex coordination row above; this is expected concurrent enhancement of the same singleton,
  not a regression of this PR's scope. (b) `.github/workflows/sentry-ci-report.yml` +
  `scripts/sentry-ci-report.py`, ADDITIVE ONLY (zero edits to any pre-existing workflow): on
  `workflow_run: types:[completed]` across all 7 workflows that existed at authoring time (CI,
  Codex Autofix, Deploy, Sync Preview Lanes, Shared package pin check, Playwright Smoke,
  Security) — failure conclusion -> raw-envelope Sentry error event {workflow, branch, actor}
  fingerprinted [workflow, branch]; schedule-triggered runs -> Sentry Crons check-in mirroring
  that workflow's own cron (slugs `ci-security`, `ci-playwright-smoke`,
  `ci-shared-package-pin-check`). Repo secret `SENTRY_FLEET_DSN` set via `gh secret set` (value
  never echoed). Locally dry-ran the reporter script against the real DSN before pushing — both
  envelope POSTs returned HTTP 200. Landed via `scripts/land.sh` (merged `origin/main`'s
  concurrently-merged PR #370 cleanly first) + `gh pr merge --squash --auto`. See
  `docs/rollouts/2026-07-04-fleet-sentry-observability.md`.
- PR #370 - CI Actions efficiency: docs-only fast path on required `verify` (fail-closed gate-job pattern incl. --no-renames + !cancelled() Codex-review fixes), .next/cache restore/save split (PR restore-only, main-push save), cleanup-caches.yml (PR-close delete + daily prune backstop). Merged 2026-07-04; hybrid runner-routing follow-up continues as claude/ci-hybrid-runner-verify (PR #372).
- PR #350 - AI Review inheritance, model catalog, and text-box font controls.
- PR #349 - Socratic admin/RAG/Pinecone/settings parity implementation.
- PR #348 - Sell to Fund Buys title-case copy fix.
- PR #347 - Console universe index exclusivity fix.
- PR #346 - IRA wash-sale UI correction.
- PR #345 - Run-state UX fix.
- PR #344 - Socratic Trade Autonomy Desk implementation.
- PR #340 - Socratic Trade rebrand.

## In Progress

- **Wave-3 memory/RAG (CLAUDE swimlane, 3-lane team) — IN PROGRESS 2026-07-04 (gated on cars 11-14 reaching main):**
  w3-schema-dissent (frontier tier: belief/iMayBeWrongIf/reversalTriggers/evidenceRefs schema fields
  w/ Bear round-trip, structured Red Team verdict + removed[], non-action case files, debate
  transcript persistence); w3-permodel-loop (mid tier: per-model scoreboard/calibration/deterministic
  assignment + structured-output conformance recording); w3-retrieval-usefulness (mid tier:
  ragAttribution+analog-id joins to matured outcomes, per-source usefulness data, learned-fact
  injection efficacy w/ per-run fact-id stamping).

- **CODEX console/UI swimlane (Codex, worktree `/Users/jay/apps/trading-codex-ui-swimlane`,
  branch `codex/console-ui-swimlane`) — claimed 2026-07-04 from sync-21.** Priority:
  approvals surface pack first (approval-card provenance, red-team trigger chip, R:R geometry,
  mobile LIVE phrase-gate parity, Sheet focus-trap), then `/console/decisions/[id]` decision-trace
  inspector over the W2 case shapes, coach-on-trace UI, and the reserved ticker/settings/model
  parity trio. KEEPOUT: Claude memory/RAG internals and Monet risk gates.

- **Codex global coordination + fleet monitoring setup (Codex, shared `/Users/jay/apps`
  infra) — 2026-07-04.** Scope: make Codex follow the canonical `#agent-sync` +
  effort-log protocol across current/future repos, add missing bootstrap/audit
  tooling, and extend the singleton `fleet-sentry-monitor` with Codex-specific
  breadcrumbs/warnings instead of creating a duplicate monitor. Collision notes:
  do not touch Monet PR #367's repo Slack engine; do not duplicate Claude's
  `fleet-sentry-monitor` / `sentry-ci-report.yml` singleton lanes. Current state:
  `.secrets` bot-token Slack posting verified, Codex host/session breadcrumbs
  added to the singleton monitor, stale Codex OTLP config removed from
  `~/.codex/config.toml`, and Congress.Trade docs-only PR #137 opened with green
  checks.

- **`claude/ci-hybrid-runner-verify` (Claude, worktree `~/apps/trading-wt-ci-efficiency`) —
  moved from Planned 2026-07-04 after PR #370 merged.** Hybrid resource-aware runner routing for
  the required `verify` check (owner re-confirmed with design; verbatim intent: "hybrid so that
  it only uses local when there is sufficient extra CPU/RAM available"). ci.yml 2 jobs -> 4:
  classify (+route output; self only for fresh <5 min publisher state on same-repo
  pull_request/push, everything else hosted), verify-self (macOS lane: [self-hosted,
  trading-live], timeout 30, concurrency-1, guard, node fail-fast, nice -n 19, macOS cache
  namespace), verify-hosted (Linux lane: routed-hosted + exactly-one auto re-run when self did
  not succeed; saves Linux .next cache on main pushes AND nightly schedule), verify (REQUIRED
  check, pure gate: fail-closed on classify failure, hosted wins on disagreement — Linux
  arbiter, per-run environment annotation). Nightly hosted canary cron. New owner-run
  scripts/runner-availability.sh (ASCII, bash-3.2-verified) publishes VERIFY_RUNNER_STATE every
  60s (load<0.6/cpu, RAM>6GB free+inactive, runner alive, pm2 trading online; 2-check
  hysteresis to self, instant hosted on busy, EXIT-trap hosted). Repo var pre-created
  {"mode":"hosted","ts":0} — merging changes nothing until the owner starts the publisher (pm2
  one-liner in docs/rollouts/2026-07-04-ci-hybrid-runner-verify.md, which carries the full
  history/objections/re-confirmation + gate decision table + failure-mode table). STATUS:
  implemented, verification green (yaml-lint, bash 3.2 -n + ASCII, 8-case route test, read-only
  Mac probes, local quartet), PR #372 open, auto-merge armed.

- **`claude/drawdown-advisory-rescope` (Monet, cloud — risk swimlane) → PR #360, auto-merge armed.**
  `drawdownBreakerAction = "advisory"|"close_only"|"halt"`, default advisory: breach → receipt +
  `drawdownAdvisory` block in strategist context, NO systemState flip; halt/close_only explicit
  opt-in. Reverts #343's hard-halt default. Gates green (tsc/lint 0/2375 tests/build).
  Follow-on (Monet): adopt the typed regime enum inside breaker/crisis-cap/bear-filter after
  Fable's w1-regime-data hits main. _(Row mirrored by Fable — Monet is cloud-side and cannot
  write this board directly; repo docs/EFFORT-LOG.md carries Monet's own copy.)_

- Wave-1 quick wins from the composite expert review (Claude coordinator, 4 Sonnet lanes, push-only branches; landed via the 2026-07-04 landing train — Fable operator):
  - `claude/w1-llm-fixes` — Bear schema confidenceScore fix (live bug); non-OpenAI reasoning-token headroom; cross-family Bear default + temperature; reward-abstention; stakes-scaled dissent trigger. STATUS: **MERGED (PR #364)**.
  - `claude/w1-learning-loops` — Bear-veto counterfactuals + red-team efficacy scorecard; re-index decision memory on lifecycle changes; trading-day horizon arithmetic; + Codex second-pass review fixes (market-day horizon anchoring via new `market-calendar.marketDateOf`, kind-scoped veto audit queries + keyed efficacy joins, NULL-evidence backfill on `insertSkippedCounterfactualCandidate`). STATUS: **MERGED (PR #365)**. `getRedTeamEfficacy()` remains API/db-level only (console lane owns UI wiring). Deferred: `skipped_candidate_counterfactuals` has no `side` column, so vetoed SHORTs still read as long moves in the GENERIC missed-opportunity path (efficacy path side-adjusts) — candidate for the w2-outcome-engine lane's schema pass.
  - `claude/w1-rag-quickwins` — relevance floor + near-dup dedupe wired; provenance headers + stable chunk ids; content-hash dedup on + 128-bit; embedding-model version tag; rerank pool cap. STATUS: **MERGED (PR #366)**.
  - `claude/w1-regime-data` — typed regime enum + numeric severity (new dependency-free `src/lib/market-regime.ts`); live ^VIX off the 24h macro cache; per-data-class TTLs + asOf on Alpaca snapshot. STATUS: **MERGED (PR #368)**. NOTE (correction to the earlier row text): the crisis cap (policy.ts) and bear filter (strategy.ts) deliberately KEPT their substring checks per the Fable/Monet swimlane keepout — enum adoption inside risk gates is Monet's (#360 landed with them intact); only the console regime card adopted the enum.

- 2026-07-04 landing train (Fable operator) — also landed: `claude/console-small-fixes` (**PR #361**), `claude/washsale-advisory-defaults` (**PR #362**), `claude/socratic-expert-review-doc` (**PR #363**), `claude/agent-sync-protocol-docs` (**PR #369**). Wave-2 lanes now landing sequentially: `w2-episodic-retrieval` (PR #437 in flight), then `w2-outcome-engine`, `w2-coaching-durable`, `w2-reflection-decompose`.

- **`claude/tokenless-git-dep` (Claude, worktree `/Users/jay/apps/trading-wt-tokenless-dep`) —
  2026-07-04, cross-repo effort resuming a died-mid-task lane.** `congress-trading-shared` is
  now public; owner-directed switch from the private GitHub Packages registry
  (`NODE_AUTH_TOKEN` auth) to a tokenless git dependency. Shared repo's prep work
  (`claude/tokenless-git-dep-prep`) was found ALREADY MERGED (PR #7) with tag `v1.2.0`
  already cut before this session started — see
  `/Users/jay/apps/CONGRESS-SHARED-EFFORT-LOG.md`. This row covers the Socratic.Trade
  consumer switch: `package.json` -> `github:jaywedgeworth22/congress-trading-shared#semver:^1.2.x`,
  dropped `.npmrc`, regenerated lockfile tokenlessly (proven: clean `npm ci` with
  `NODE_AUTH_TOKEN` unset and `GIT_SSH_COMMAND=/bin/false`), removed
  `scripts/npm-ci-with-shared-deps.sh` and its call sites in `ci.yml`/`deploy.yml`/`e2e.yml`/
  `codex-autofix.yml`/`sync-previews.yml`/`scripts/sync-preview-lanes.sh`/`scripts/cloud-setup.sh`.
  Coordination note: PR #372 (`claude/ci-hybrid-runner-verify`) is open and also touches
  `ci.yml` — this branch merges `origin/main` before landing and keeps both changes if #372
  lands first. Congress.Trade gets its own PR (separate repo, separate AGENTS.md rules).
  STATUS: gates green locally (lint 0 errors, tsc clean, 2449 tests, build ok); opening PR next.

## Planned / Reserved Before Implementation

- **CI standard rollout (cross-app, Claude coordinator) — RESERVED, RE-SCOPED 2026-07-04.**
  Deferred until the hybrid resource-aware routing PR above lands and proves itself. Scope when
  picked up: convert the verify gate to a reusable `workflow_call` (hub = this repo,
  **hosted-only by default, zero self-hosted references baked in**; resource-aware routing is a
  separately-approved explicit opt-in input per repo, never inherited silently), flip hub Actions
  access to owner-repos, add caller workflows to congress-trading-shared + API-usage-monitor
  (+ Congress.Trade when bootstrapped), and update canon/global-config bootstrap stanza for
  future repos.

- **Wave-2 memory/RAG core (Claude/Fable coordinator — OWNER-ASSIGNED swimlane) — IN PROGRESS as of 2026-07-04 (moved from Planned; lanes stacked on their w1 dependency branches rather than waiting for the train).** Lanes:
  - `outcome-engine` — outcome writer (matured outcomes onto decision cases), multi-horizon
    `outcomes[]` (15m/1h/1d/1w, SPY-relative, vs-alternatives), durable due-jobs substrate,
    survivorship kill (terminal `unresolvable` + coverage disclosure).
    STATUS: **implemented 2026-07-04** on `claude/w2-outcome-engine` (worktree
    `~/apps/trading-wt-w2-outcome`, base `origin/claude/w1-learning-loops`). New scheduled job
    `src/lib/outcome-engine.ts` on the counterfactual cadence: placed decisions join
    fill_events/closed lots; blocked/rejected (incl. Bear vetoes) join counterfactual refPrice;
    writes `outcome`+`measuredAt`, per-case receipt, awaited vector-memory re-index. Multi-horizon
    `outcomes[]` rows land on decision cases AND skipped-counterfactual rows (new
    `outcomes`/`resolution_reason` columns); 1d/1w from the daily cascade SPY-relative
    (trading-day arithmetic); 15m/1h only via an actually-sampled live quote, else honest
    `unresolvable(no_intraday_source)`. Kill-survivorship: terminal `unresolvable` after a
    bounded 10-trading-day recheck; coverage disclosures on job receipts, `getRedTeamEfficacy`,
    missed-opportunity summary, `certifyForwardResolution`. Budget-gated batch-capped LLM
    post-mortem lessons at maturation (direction-tagged + verdictOnBelief/whichDissentMattered)
    via `ingestLearned` origin `autonomous`; all skips receipted. NOT in this slice (per spec):
    the durable due-jobs substrate (separate later item), vs-alternatives `altReturnPct`
    population, multi-horizon IC in the backtest learner. Verification green (lint 0 errors /
    tsc clean / 2383 tests / 246 files / build). Pushed, no PR — lands via the train after
    w1-learning-loops. See docs/rollouts/2026-07-04-w2-outcome-engine.md.
  - `episodic-retrieval` — new `experience-memory.ts`: decision-time k-NN analogs +
    counterexamples + owner-coaching blocks into Bull AND Bear; situation-sketch queries.
    STATUS: **implemented 2026-07-04** on `claude/w2-episodic-retrieval` (worktree
    `~/apps/trading-wt-w2-episodic`, base `origin/claude/w1-rag-quickwins`). Closed-lot experience
    writer hooked in `recordFillFromProposal` (keyed by entry proposalId, realized
    return/holding-days/risk-exit/mae-mfe metadata); second retrieval pass over
    ['socratic-decision','coach-note','lesson'] with situation-sketch query, cross-symbol,
    same-run exclusion, as-of stamp; labeled analogs (+COUNTEREXAMPLE) + owner-coaching blocks in
    BOTH Bull and Bear payloads; injected ids persisted per run (`experience_retrieval` audit +
    rag attributions). Verification green (lint 0 errors / tsc clean / 2395 tests / build).
    Pushed, no PR — lands via the train after the w1-rag-quickwins base lands. See
    docs/rollouts/2026-07-04-w2-episodic-retrieval.md. Known v1 gap: live closing fills write
    their experience only after reconciliation (paper covered today).
  - `coaching-durable` — coach notes through `ingestLearned` (origin `coach`), kill the silent
    `slice(-20)`, coach-note vectors, approvals routing for risk-tier notes. STATUS: **implemented
    2026-07-04** on `claude/w2-coaching-durable` (worktree `~/apps/trading-wt-w2-coaching`, base
    `origin/claude/w1-learning-loops`). `appendSocraticDecisionCoachNote` now runs every note through
    `ingestLearned` (origin `'coach'`): fact-tier → durable `learned_context` row linked to the
    decision id (`subject: coach:<decisionId>`); risk/directive-tier → the existing approval inbox
    (not chat-hard-capped). `coachNotes.slice(-20)` replaced with archival to a new
    `socratic_coach_note_archive` table (append-only, never deleted) + a receipt audit event emitted
    only when archival occurs. Coaching outcome stamped as a `coaching`-kind evidence item so coached-
    case retrievals carry "coached"/promoted-to-durable-lesson provenance. New
    `buildCoachNoteMemoryDocument`/`indexCoachNoteMemory` in `socratic-memory.ts` store each note as
    its own retrievable vector (`doc_type: 'coach-note'`, metadata `{symbol, thesis_tag, regime,
    decision_id}`). New `listApprovedRiskContextForDecision` in `db-learning.ts` feeds a labeled
    "OWNER-APPROVED GUIDANCE (advisory)" block with approval date into `retrieveLearnedContext` —
    previously an approved risk row never reached any prompt. `LearnedContextOrigin` widened to
    include `'coach'` with a guarded `sqlite_master`-DDL rebuild so existing on-disk DBs accept the
    new origin. Verification green (lint 0 errors / tsc clean / 2383 tests / build). Pushed, no PR —
    lands via the train after its w1-learning-loops base lands. See
    docs/rollouts/2026-07-04-w2-coaching-durable.md.
  - `reflection-decompose` — **done, pushed, awaiting the landing train** (branch
    `claude/w2-reflection-decompose`, base `origin/claude/w2-episodic-retrieval`, STACKED).
    Reflection blob → discrete (thesisTag x regime) lesson rows in `learned_context` (new
    `regime`/`thesis_tag`/`dominant_factor` columns; min 5 lots per bucket; regime-agnostic
    `@all-regimes` fallback for thin regimes) carrying realized win-rate/MAE-MFE/capturePct, each
    ALSO embedded as a `doc_type="lesson"` vector consumed by the episodic lane's retrieval pass.
    Blob DEMOTED out of the Bull system prompt once lessons exist (kept as zero-lesson fallback).
    `retrieveLearnedContext` boosts by current run regime + candidate theses and labels
    mismatched-regime facts "(learned in <regime>)" — label, never filter. Reflections re-keyed
    (userId, accountNumber) into the append-only `reflection_versions` table (monotonic version +
    input-stats hash; two-account clobber fixed; account-deletion covered). Verify green: lint 0
    errors / tsc clean / 2404 tests / build. See
    docs/rollouts/2026-07-04-w2-reflection-decompose.md.

- Universal ticker detail drawer parity - restore old-site discoverability by
  making ticker symbols open a shared right-side drilldown drawer consistently
  across scan, home, evidence cards, proposals, orders, activity, outcomes,
  approvals, and watchlist. Reserved under the broader Codex parity effort.
- Settings affordance and tooltip pass - add clearer option descriptions/tooltips,
  replace confusing loose/tight wording with lock/unlock-style affordances, and
  turn absolute-vs-percent constraint pairs into polished mode switches where
  they represent alternative ways to express one setting.
- Model/provider control parity - move strategy model controls toward curated
  dropdowns with provider-aware settings, showing reasoning controls only for
  models that actually support them.
- Admin connection health and backend-failure notification pass - surface every
  backend dependency including Pinecone/Voyage, distinguish global backend failures
  from user-key failures, and route global failures to admin email/health while
  user-key failures become user notifications.
- Old-vs-new console parity audit follow-through - review the legacy dashboard for
  features still missing or less discoverable in `/console`, including scan column
  customization, admin/operator navigation, account display preferences, and
  connection status.

## Changelog

- 2026-07-04 - Closed the spaced-folder diff review for
  `/Users/jay/Code/Socratic Trade`: it is a stale standalone checkout on the old
  `agentic-trading` remote, not a PM2-backed active worktree. Its dirty
  improvements were already present or superseded in `/Users/jay/Code/Socratic.Trade`
  (`next-env.d.ts`, Sentry `next.config.mjs`, `.mcp.json`, opening-notional
  naming, side-adjusted return comments, and opening-side risk comments). Did not
  port its `@jaywedgeworth22/congress-trading-shared` `^1.0.0` package range
  because the active repo intentionally pins `1.0.0` in current docs and the
  GitHub Packages registry check failed with `E401`, so changing that here would
  be unaudited dependency drift.
- 2026-07-03 - Created branch-neutral canonical log at `/Users/jay/apps/TRADING-EFFORT-LOG.md`.
