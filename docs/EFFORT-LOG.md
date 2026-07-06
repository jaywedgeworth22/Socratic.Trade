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

- 2026-07-06 - `trading-live` published at `7b5450fe` on `socratictrade.com` (CLAUDE, owner-run
  `~/apps/trading-publish.sh`). Ships the full CLAUDE backlog train (#816 prompt-safety, #819
  usage-budget advisory, #820 due-jobs, #822 hyde-multiquery) plus everything merged to `main`
  since (incl. #875 Red-Team policy-aware routing). Verified: local `:4000` + public
  `socratictrade.com` `/api/health` 200, `db: ok`, scheduler ticking, pm2 `trading` online with
  `unstable_restarts: 0`, live HEAD == `origin/main`. **Incident recovered during this deploy
  (host-side, not code):** prod was 500 crash-looping on a missing `better-sqlite3` native binary
  because (1) `~/.npmrc` had a stray `allow-scripts=happy` line that npm 11 rejects as
  `EALLOWSCRIPTS`, aborting `npm ci` on the `congress-trading-shared` git dependency (and `npm ci`
  wipes `node_modules` first → full outage), and (2) `brew` had bumped the default `node` 24→26
  (npm 10→11) though the repo pins node 24 (`.nvmrc`). Fixes: emptied `~/.npmrc`
  (backup `~/.npmrc.bak-20260706-deploy`), `brew link node@24` as default, hardened
  `~/apps/trading-publish.sh` to force `node@24` on PATH so future brew drift can't rebreak deploys.
- 2026-07-04 - `trading-live` published docs-only PR #446 at `497d06c9` on
  `socratictrade.com`; production health 200; repo mirror now records Codex PR
  #442 and PR #444 as deployed. This is the current production HEAD and contains
  the prior deployed code commit `1e1a15bc`.
- 2026-07-04 - `trading-live` published at `1e1a15bc` (PR #444) on
  `socratictrade.com`; production health 200; tokenless public HTTPS
  `congress-trading-shared` dependency path is live in the deployed build.
- 2026-07-04 - `trading-live` contains `94669873` (PR #442); production health
  200; Codex console/UI swimlane is live, including approval provenance/citations,
  mobile LIVE phrase parity, Sheet focus trap, read-only decision trace, ticker
  drawer parity, and Strategy custom-model select parity. Verified Deploy
  workflow success, PM2 `trading` online, `/api/health` 200, and built
  route/page artifacts present under `.next/server/app`.
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

- **Congress.Trade Improvements (AG, M)** — Comprehensive improvements across UI, data sharing, and scraping. Worktree `~/apps/trading-antigravity`, branch `agent/antigravity`.
  1. [x] **UI/UX Mobile Refactor**: Implement responsive cards/scroll for data tables in `dashboardHtml.ts`.
  2. [x] **Shared Ticker Aliases**: Move ticker alias resolution logic into `congress-trading-shared`.
  3. [x] **Typed API Client SDK**: Build and export a strongly-typed `CongressTradeClient` in the shared repo.
  4. [x] **Senate Scraper Handshake**: Implement Cloudflare KV session caching for the Senate eFD agreement gate. (Merged PR #882)
- **PR #844 - `claude/pr805-remediation`: P0 checkRegimeFlip RMW fix + P1 backlog + AG connection-health
  slice, merged as one honest PR (CURSOR + AG + CLAUDE remediation) — ✅ COMPLETED, merged 2026-07-05
  (squash `ebcf6a23`).**
  _2026-07-05 (CLAUDE audit-c3): Origin-verified CRITICAL correction — the cycle-2 rows across this
  board asserting the P0 multi-user regime RMW race and security headers are NOT on `main`, and that
  CONFLICTING PR #805 is "the only vehicle," are now FALSE. #844 landed: per-user
  `regime:current:${userId}` keys + legacy-row migration in `src/lib/regime-watch.ts` (confirmed
  present); HSTS/X-Content-Type-Options/Permissions-Policy response headers in `middleware.ts` +
  `test/security-headers.test.ts` (confirmed present); `LLM_SPEND_CEILING`; and the effort-orphan
  report. #844 merged BOTH the Cursor P0/P1 commit (`0ce39474`) and the AG connection-health slice
  (`b88981c4`) cleanly onto `main`, plus fixed all 16 Codex review comments from #805 (each thread
  replied + resolved). PR #805 (`cursor/session-2026-07-05`) is CLOSED as superseded — no action
  needed on it. This supersedes and closes out: the "PR #808" row (previously In Progress, moved
  here), the "Admin connection health and backend-failure notification pass (AG)" row (previously In
  Progress, moved here), and the cycle-2 "Disentangle PR #805" / "Migrate legacy regime:current row"
  Planned rows (retired as moot, see the strikethrough notes on those rows). Gate green via land.sh:
  lint 0, tsc clean, 2644 tests, build ok. Full prior resolution history (phantom-PR discovery,
  CONFLICTING diagnosis, RESOLVED note naming #844 as the real vehicle) is preserved on the two
  relocated placeholder rows in In Progress rather than deleted._
  Scope landed: **P0 fix** — removed `"local"` default from `checkRegimeFlip`, per-user regime keys
  (`regime:current:${userId}`), per-user scheduler iteration, eliminating the multi-user RMW race on
  a single `regime:current` settings row, plus first-tick migration of the legacy shared row. **P1
  backlog** — security response headers (HSTS, X-Content-Type-Options, Permissions-Policy),
  unpriced-model default cost fallback, synthetic bid/ask boolean provenance, scheduler health
  threshold, operator monthly LLM spend ceiling (`LLM_SPEND_CEILING`), effort-mirror orphan report
  script, Litestream PITR retention. Global symbol omnibox remained blocked by Codex console/UI
  keepout (not in this PR). **AG connection-health slice** — every backend dependency surfaced in
  `/api/health` and `ops-snapshot` (Database, Pinecone, Voyage, FMP, Massive, etc.); health check
  fails (503) on critical global outages (5 consecutive failures on Database/Pinecone/Voyage); global
  connection failures routed to admin (Sentry, audit log, `PRIMARY_USER_EMAIL` via Resend) while
  user-key failures stay on user in-app notifications; disk headroom, DB+WAL size, and Litestream
  last-sync age monitoring integrated with cooldown-controlled degradation alerts.
  Rollout doc: `docs/rollouts/2026-07-05-cursor-session.md` (describes intended scope; now
  confirmed-merged via #844).

---

## 🚧 In Progress

- **Design-sync: Socratic Trade UI Kit → claude.ai/design (Claude Code).** 30 primitives
  (12 `ui` + 18 `console`) converted and uploaded to claude.ai/design so the design agent
  builds with the app's real components. Render check 30/30 clean; conventions header shipped.
  Uploaded to two owner accounts (projects `0a962679…` + `1da8546c…`). Additive only —
  `.design-sync/` inputs + one `.gitignore` block, no app source changed. **PR open** on
  branch `agent/design-sync-uikit`. Rollout: `docs/rollouts/2026-07-05-design-sync-uikit.md`.

---

## ✅ Completed (merged to `main`, on beta/integration)

- **PR #979 - Persist retrieved candidate pool for RAG analyzability (CLAUDE, branch
  `claude/persist-candidate-pool`).** Merged 2026-07-06. Captures the post-recall/post-dedupe
  candidate pool from `retrieveContextDetailed` (`vector-db.ts`) — including chunks NOT making the
  final top-`limit` slice — behind new flag `RAG_PERSIST_CANDIDATE_POOL` (default OFF,
  byte-identical when off). **Known limitation:** it captures `rankPool`'s OUTPUT pool only, so
  candidates dropped upstream by minScore/asOf/dedupe are never present, and in the flagship
  production caller (dedupe 0.6 + limit 3, both of which already hard-cap output at `limit`)
  `used:false` rows are rare/absent — a pre-rankPool v2 with per-stage drop reasons is the real
  follow-up (see rollout note, and the deferred-work row below). New
  `src/lib/rag/candidate-pool.ts` (`recordCandidatePool` → `audit("rag_candidate_pool", ...)`, no
  new table); ids/scores/docType/asOf/`used` only, never raw chunk text. `RetrieveOptions.runId`
  added (additive) and threaded from both `strategy.ts` retrieval call sites +
  `experience-memory.ts`. Coordinated with sibling lane `claude/typed-retrieval-status` (same file,
  disjoint region — this lane owns only the block right before the final slice; landed after it).
  Local verify: `tsc --noEmit` clean, `test/persist-candidate-pool.test.ts` (new) +
  `test/rag-retrieval-regression.test.ts` 26/26 green, plus spot-checked adjacent RAG/strategy/
  experience-memory suites, no regressions; `land.sh` full gate (tsc/test/build) green at merge.
  Rollout: `docs/rollouts/2026-07-06-persist-candidate-pool.md`.
- **PR #977 - Corpus-coverage receipt for requested-but-empty filings doc types (CLAUDE, branch
  `claude/corpus-coverage-receipt`).** Merged 2026-07-06. Advisory-only per-run receipt: when
  strategy.ts's filings-RAG pass requests a doc type that produces zero chunks THIS run, emits one
  `audit('rag_doc_type_coverage_empty')` + one kind-`safety` decision-case evidence item. Never
  touches `ragContext`/sizing/policy — advisory only, no flag (mirrors the unconditional
  `evidence_age_anomaly` receipt). Rollout: `docs/rollouts/2026-07-06-corpus-coverage-receipt.md`.
  - **2026-07-06 BLOCKER fix (same day, pre-merge):** the original design gated the receipt on
    "zero ever-ingested `ingested_accessions` rows corpus-wide" as the producer-existence check.
    That signal was itself broken: the default-ON 8-K SUMMARY writer
    (`src/lib/web-sources/sec8k.ts`'s `refreshEightK`, via `storeContexts`) writes retrievable
    `doc_type: "8-k"` chunks but never calls `insertIngestedAccession` — only the default-OFF
    full-body writer does. So `ingested_accessions` had ZERO "8-k" rows in the default config even
    with real 8-K chunks in the corpus, meaning the receipt false-fired "8-k" on any day an 8-K
    chunk didn't rank top-3 — routinely, not rarely. Investigated `document_chunks` as a
    corpus-truth replacement (the reviewer's suggestion) and confirmed it's not viable: no
    `doc_type` column in its schema, not populated unconditionally by every writer, and
    `source`/prefix values aren't a reliable per-doc_type proxy (`disclosure-rag.ts` shares one
    prefix across two different doc types). Fixed per the task's documented fallback: dropped the
    runtime `ingested_accessions` producer-count entirely; added a static
    `COVERAGE_CHECKED_DOC_TYPES = ["10-k", "10-q", "8-k"]` allowlist (`src/lib/strategy.ts`) of
    doc types hand-verified to have a producer in code; `computeEmptyDocTypes`
    (`src/lib/prompt-safety.ts`) narrowed to `(coverageCheckedDocTypes, retrievedDocTypes)` with no
    DB dependency at all. Also fixed the companion noise finding: `earnings-transcript` (genuine
    zero-producer, no writer anywhere) excluded from `COVERAGE_CHECKED_DOC_TYPES` (stays in the
    harmless retrieval-request literal) so it no longer fires a receipt every single run forever.
    `ingestedAccessionCountForDocType`/`ingestedAccessionCountsByDocType`
    (`src/lib/db-learning.ts`) kept as general-purpose diagnostic helpers (doc comment corrected
    to spell out the "8-k" undercount caveat), just no longer used by this receipt. Added the
    regression test the fix requires (`test/rag-doc-type-coverage.test.ts`, "(c) REGRESSION"):
    stores an 8-K summary chunk with NO `insertIngestedAccession` call anywhere and asserts no
    false-positive receipt for "8-k". 11/11 passing (was 10/10); `npx tsc --noEmit` clean; 42/42 +
    31/31 regression spot-checks unchanged. Full rationale in the rollout note's new "Correction"
    section.
  - **2026-07-06 THIRD fix (same day, pre-merge) — restore both-conditions guard, ledger-complete
    subset only:** the 2nd fix above traded the 8-K false-positive for a new daily-noise bug:
    firing on this-run-retrieval-emptiness ALONE (no producer check at all) means 8-K —
    event-sparse, routinely won't rank top-3 — would fire the receipt on a large fraction of
    normal runs. Redesigned: `COVERAGE_CHECKED_DOC_TYPES` narrowed to `["10-k", "10-q"]` (only the
    types whose `ingested_accessions` producer ledger is COMPLETE — `sec-filings.ts` writes an
    accession row for every 10-K/10-Q ingest; `8-k`'s default-ON summary writer does not, so its
    ledger can't distinguish "no coverage" from "didn't rank today" — excluded;
    `earnings-transcript` stays excluded, no producer anywhere). Restored the BOTH-CONDITIONS gate
    for that subset: `computeEmptyDocTypes` (`src/lib/prompt-safety.ts`) gained a third
    `hasProducerForDocType` predicate parameter — a type is "empty" only when NOT retrieved this
    run AND the predicate reports zero producer rows. Kept `prompt-safety.ts` DB-free:
    `strategy.ts` builds the predicate from ONE bulk `ingestedAccessionCountsByDocType()` call + an
    in-memory prefix lookup (not N per-type queries). Rewrote `test/rag-doc-type-coverage.test.ts`
    (14/14 passing) including the key low-noise case: a 10-K that didn't retrieve this run but HAS
    a producer row must stay silent. `npx tsc --noEmit` clean; `strategy-prompt-safety`/
    `strategy-rag-quickwins-wiring` sweep 5/5. This is the corpus-truth-then-ledger-scoped redesign
    that shipped — full rationale in the rollout note's new "Second correction" section.
- **PR #973 - RAG golden-eval expansion: episodic-analog cases + single-vs-multi-query (#822)
  (CLAUDE), branch `claude/rag-golden-eval-episodic`.** Merged 2026-07-06. Test/fixture/docs only,
  no production code changed. Added 10 new fixture cases to
  `test/fixtures/rag-retrieval-eval-fixture.ts` covering `EPISODIC_DOC_TYPES`
  (`socratic-decision`/`coach-note`/`lesson`) — the prior 462-line fixture had zero non-filings
  cases, so the harness reportedly saturated at recall 1.0. Each new case has near-miss hard
  negatives (same symbol/regime, wrong thesis or side) so it's actually discriminating. Added two
  `describe` blocks to `test/rag-retrieval-eval.test.ts`: an episodic recall@k/MRR suite (reuses
  the existing scorer via a minimal additive `cases` option on `runFixture`) and a
  single-query-vs-multi-query suite exercising `RetrieveOptions.queries`/`rrfFuse` (#822) directly
  against `retrieveContextDetailed`, asserting no-regression + that the fused pool draws from
  multiple query lists (one `mocks.query` call per fan-out variant). No RAG env flag defaults
  touched. tsc clean; focused `test/rag-retrieval-eval.test.ts` +
  `test/rag-retrieval-regression.test.ts` = 36/36 passing (17 new).
  **2026-07-06 follow-up (2nd commit, pre-merge) — baseline-population + recall-discrimination
  fixes:** the "filings behavior byte-identical" claim above was actually FALSE — the filings
  baseline/rerank/hybrid/as-of `it`s had no `cases` filter and were silently scoring the full
  39-case mix (measured MRR 0.919) instead of the original 29 filings cases (MRR 1.0). Fixed by
  adding `FILINGS_CASES` and wiring it through every filings-only `it`; filings MRR confirmed back
  to 1.0. Also added an explicit `recall1` assertion over the episodic cases (`toBeCloseTo(0.4, 5)`,
  the actual measured value, since recall@3 alone saturates at 1.0 and can't discriminate), and
  replaced a brittle Set+fixed-array-slice assertion in the multi-query plumbing test with a
  no-dupes + all-from-pool check. Still 36/36 passing, tsc clean. Rollout:
  `docs/rollouts/2026-07-06-rag-golden-eval-episodic.md`.
- **PR #970 - Typed retrieval-status receipt (CLAUDE, branch `claude/typed-retrieval-status`).**
  Merged 2026-07-06. Distinguishes no-memory vs lookup-failed vs budget-skipped vs degraded
  instead of every RAG/episodic retrieval outcome collapsing to an indistinguishable `[]`/
  non-empty result. Additive/advisory-only: new `RetrievalStatus` union + optional
  `RetrieveOptions.onStatus` callback wired through the four existing classification points in
  `retrieveContextDetailed` (vector-db.ts), a new `status` field on `ExperienceRetrievalResult`
  (experience-memory.ts), per-symbol/PORTFOLIO capture in strategy.ts persisted via a new
  `rag_retrieval_status` audit row alongside `experience_retrieval`, and an additive optional
  `ragRetrievalStatus` field on `SocraticDecisionCase` (types.ts) — persistence only, no rendering.
  Never gates/alters chunk selection. Coordinated with sibling lane `claude/persist-candidate-pool`
  (also edits `vector-db.ts` `retrieveContextDetailed`) — this diff was kept minimal/localized to
  the early-return points and a thin status output. Tests: `test/rag-retrieval-status.test.ts`
  (new, 11 cases, network-free). Pre-merge Copilot review caught a real bug:
  `retrieveContextDetailedWithStatus`'s forwarding call to a caller-supplied `onStatus` would
  propagate a throwing callback instead of swallowing it (breaking the "throwing callback never
  affects retrieval" contract every other call site relies on) — fixed with a try/catch + a
  regression test. Rollout: `docs/rollouts/2026-07-06-typed-retrieval-status.md`.
- **PR #974 - Held-position retrieval scope (CLAUDE, worktree `~/apps/trading-wt-held-scope`,
  branch `claude/held-position-retrieval-scope`).** Merged 2026-07-06. Widens the three retrieval
  scopes in `runStrategyOnce` (filings RAG `topSymbols`, learned-context `learnedSymbols`, episodic
  `situationCandidates`) to UNION in every held (open) position's symbol, not just the score-sorted
  top-N scan candidates — so sell/hold/trim decisions on a held name outside the top slice get
  retrieved memory too (previously zero). Strictly additive: the BUY-candidate scan/prompt set
  (`marketScan.topCandidates`) and its ordering are unchanged; no risk-gate/sizing/policy touch.
  Hoisted the pre-existing `heldSymbols` computation (was locally recomputed for take-profit
  trim-band pruning) to a single shared value. New test:
  `test/strategy-held-position-retrieval-scope.test.ts` (2 tests, held-symbol inclusion + no
  duplicate retrieval + top-N regression). tsc clean, focused strategy/market/learned-context/
  experience-memory suites green. Rollout: `docs/rollouts/2026-07-06-held-position-retrieval-scope.md`.
  **Follow-up fix (same day, 2nd commit, pre-merge) — episodic-sketch gap:** episodic
  `buildSituationSketch` (`src/lib/experience-memory.ts`) still did a bare `slice(0, 3)` on
  candidates, so held symbols appended past top-3 reached the `retrieveDecisionExperiences` call
  but were dropped before entering the actual sketch/query text — episodic parity was only
  partial. Fixed with an additive `SituationCandidate.held` flag + a bounded (max 6) held-aware
  selection in `buildSituationSketch`; non-held path is byte-identical to the old slice. 4
  new/strengthened tests across `test/experience-memory.test.ts` +
  `test/strategy-held-position-retrieval-scope.test.ts`; tsc clean; full `npm test` 2678/2678
  passed. Same rollout note, follow-up section appended.
  **Pre-merge Copilot review fix — cross-lane catch-block fallback bug:** with `topSymbols` now
  widened to include `heldSymbols`, the filings-RAG pass could cover more than the original top-3,
  but the typed-retrieval-status lane's (`#970`) fallback in the later `catch` block still only
  added receipt rows for `marketScan.topCandidates.slice(0, 3)` — so a full-pass failure (e.g. a
  vector-db import error) would silently omit held symbols from the `rag_retrieval_status` receipt
  even though they were now in-scope for retrieval. Fixed (commit `23784ad`): the catch-block
  fallback now iterates the same held-widened symbol set (`uniqueSymbols([...top-3,
  ...heldSymbols])`) as the happy path, so a held symbol outside the top-3 still gets a
  `lookup_failed` receipt row if the whole filings-RAG pass throws. (Same review pass also fixed an
  O(heldSymbols × topCandidates) `.find()` loop to O(heldSymbols) via a pre-built symbol→candidate
  map, and corrected a stale code comment on the `SITUATION_SKETCH_MAX_CANDIDATES` cap.)
- **PR #816 - Prompt-safety CR-H: fencing + deterministic injection receipts for the money-path
  prompts (CLAUDE).** Merged to `main` 2026-07-05 as squash `041b73b2` (verify/smoke/gitleaks
  green). Advisory ONLY (owner philosophy: receipts, never blocks): fenced
  `<owner_strategy_prompt>` + one data-not-command clause in the Bull system prompt covering every
  untrusted block (headlines/smartMoney/RAG/learned/analogs/coaching/reflection) + Bear equivalent
  (`STRATEGY_PROMPT_VERSION` 1.4.0→1.5.0); `reflection_summary` moved out of the SYSTEM prompt into
  Bull userContent as fenced `<reflection_summary>` DATA; new leaf `src/lib/prompt-safety.ts`
  deterministic injection scanner → `audit('prompt_injection_suspected')` + kind-`safety`
  decision-case evidence (detection only, never blocks/alters); learned-context lines carry inline
  provenance (`[origin= source= asserted= conf=]`); same-day high-relevance RAG chunk / same-day
  fact → aggregated `audit('evidence_age_anomaly')` + `safety` evidence item; post-mortem
  reflection WRITER fenced at source. Review pass added an excerpt cap on persisted findings (a
  ~50KB base64 blob could otherwise persist unbounded text repeatedly via the decision-case
  evidence JSON) and a fence-escape detection pattern (forged closing tags from inside untrusted
  data). Tests: 2577 total in the full local gate, all green (`test/prompt-safety.test.ts` 31,
  `test/strategy-prompt-safety.test.ts` 4, plus focused strategy/chat/socratic/learned-context
  suites). See `docs/rollouts/2026-07-05-prompt-safety-fencing.md`.
- **PR #819 - Wire `usage-budget` Phase 2 (advisory-first, owner-overridable enforcement) into
  `runStrategyOnce` (CLAUDE).** Merged to `main` 2026-07-05 as squash `f28322fe`
  (verify/smoke/gitleaks green). ADVISORY (always on when the monitor is configured):
  `usage_budget_status` audit receipt every run + a `formatBudgetAdvisory` line injected into the
  Bull userContent next to `drawdownAdvisory`. ENFORCEMENT (opt-in via `USAGE_BUDGET_ENFORCE`,
  default off) at the per-user/day LLM budget choke point: skip ends the run before any LLM call
  (audit + `notifyBudgetSkip`); downgrade swaps `policy.llmModel`/`redTeamLlmModel` on the
  in-memory run policy only, never persisted. `debateProposal` gained an optional `policyOverride`
  param so the Bear picks up the same transient downgrade. **Adversarial review caught a BLOCKER
  pre-merge:** the enforcement block was mutating the shared `policy` object in place, so a
  same-run cap-breach demotion's `setPolicy({ ...policy, strategyAuthority: "propose" })` would
  have persisted the downgraded models to the DB permanently, contradicting the "never persisted"
  contract; fixed with a separately-carried `runLlmOverride`/`runPolicy` never passed to
  `setPolicy`/`autoRevertOnCapBreach`, plus a regression test that trips both a downgrade and a
  cap-breach demotion in the same run. Also fixed: scoped the enforcement try/catch so a post-audit
  throw in the skip path can't be swallowed into the full LLM path; threaded the downgrade into
  `generateReflectionSummary` (outcome-engine lesson pass left as a documented intentional
  exemption — fire-and-forget, outlives the run); de-duplicated the budget-status fetch; extended
  the downgrade test to assert the Red Team request body's model too. Full local gate: 2587 tests
  across 261 files, all green; build clean. See
  `docs/rollouts/2026-07-05-usage-budget-advisory-wiring.md`.
- **PR #820 - Durable due-jobs substrate for 15m/1h intraday outcome sampling (CLAUDE).** Merged to
  `main` 2026-07-05 as squash `e90db1a8` (verify/smoke/gitleaks green). New `due_jobs` table
  (migration v11) + `src/lib/db-jobs.ts` (lease/reclaim claimable queue — fixes the
  crashed-row-stuck-forever gap the existing `mobile_commands` queue has). `counterfactual-learning.ts`
  + `outcome-engine.ts`'s `measureCase` enqueue `sample_intraday_horizon` jobs once a case's basis
  (fill or ref price) resolves; new `drainDueIntradaySampleJobs` worker drains them through the same
  `mergeHorizonRows`/write path the existing inline `samplableNow` path uses (belt-and-suspenders,
  no duplicate rows); one fire-and-forget call added to `scheduler.ts`'s `tick()`. **Adversarial
  review caught a lost-update-race BLOCKER pre-merge:** `measureCase` held an outcomes snapshot
  across awaits, so its wholesale write could erase a 15m/1h row the due-jobs worker had already
  persisted concurrently; fixed by re-merging against a fresh DB read immediately before every
  terminal/partial write (`writeSocraticDecisionOutcome`, `markSkippedCounterfactualMatured`,
  `markSkippedCounterfactualUnresolvable`). Also fixed: claimant-fenced the three terminal-transition
  functions in `db-jobs.ts` (a stale/lease-expired worker could otherwise resurrect an
  already-completed job); renamed the drain receipt's `failed` counter to `erroredRetried` +
  removed the dead `'failed'` `DueJobStatus` value; replaced the worker's `caseId.split(":")`
  counterfactual lookup with an exact `runId`/`horizonDays`-keyed lookup (the split-based lookup
  could silently match the wrong row when a run/symbol pair had more than one horizon-day config);
  added `due_jobs` to the account-deletion drift guard. Full local gate green (2529+/2530+ full
  suite, build clean). See `docs/rollouts/2026-07-05-durable-due-jobs.md`.
- **PR #822 - HyDE + evidence-derived multi-query retrieval for filings RAG, flag-gated (CLAUDE).**
  Merged to `main` 2026-07-05 as squash `d97b7c71` (verify/smoke/gitleaks green). New
  `src/lib/rag/multi-query.ts`: pure `deriveQueryVariants()` (2-4 facet sub-queries from
  evidence/sector/dominant-factor) + `generateHydePassages()` (one cheap fail-open LLM call, HyDE
  passages). Two flags `RAG_MULTIQUERY`/`RAG_HYDE` (+`RAG_HYDE_MODEL`), both **default OFF** —
  byte-identical retrieval when both are off (pinned by a dedicated regression test); not
  independent, `RAG_HYDE` alone is a no-op without `RAG_MULTIQUERY`. `vector-db.ts`
  `RetrieveOptions.queries?: string[]`: per-query embed+match (including the original query
  alongside variants), RRF-fused into the existing `rankPool` pipeline unchanged. **Adversarial
  review caught a fail-CLOSED BLOCKER pre-merge:** the multi-query fan-out had no per-item catch,
  so one variant's rejected Voyage/Pinecone call discarded every other variant's already-successful
  results via a bare `Promise.all`, returning empty filings context instead of falling back to the
  single-query path; fixed so each fan-out call is caught individually and an all-fail case falls
  back to plain single-query retrieval (flags-off behavior). Also fixed: first-occurrence-wins id
  resolution could keep a lower cosine score (now higher-score wins); HyDE's endpoint/model could
  disagree (could route an OpenAI model id to `api.anthropic.com` under an Anthropic policy,
  silently returning `[]`; now resolved coherently with an audit on non-OK responses); HyDE spend
  wasn't gated on the daily LLM budget (now gated via `isOverLlmBudget`). Full local gate: 2619
  tests across 264 files, all green; build clean. See
  `docs/rollouts/2026-07-05-hyde-multiquery-retrieval.md`.
- **Push account status metrics to Usage Monitor (AG)** — ✅ COMPLETED 2026-07-05. Pushed metricTypes `balance` and `limit` to API Usage Monitor via `usage-monitor-push.ts` upon portfolio fetch in Alpaca and Robinhood.

- **Harden HMAC Security & Persistent Idempotency for webhooks (AG, M) — ✅ COMPLETED via PR #854 (2026-07-05).** Updated `congress-webhook-auth.ts` to validate `X-Signature` header via HMAC SHA256. Created `processed_webhooks` db table and integrated persistent DB check in `markSeen` alongside in-memory cache to ensure persistent idempotency across server restarts. Lint and tests green.
  _2026-07-05 (CLAUDE audit-c3): CORRECTION — this row is mis-filed. Per protocol "Completed" = merged
  to `main`; `gh pr view 854` shows state **OPEN**, mergeStateStatus **BLOCKED** (all CI green —
  verify/smoke/gitleaks/autofix/classify SUCCESS — reviewDecision empty, no auto-merge armed). Blocked
  by the main-protection ruleset requiring review/thread-resolution, not by code. Moved to In Progress
  below pending actual merge; do not let the issues-sync mirror close its tracking issue off this
  stale Completed text. action=land-it._
- **Push account status metrics to Usage Monitor (AG, M) — ✅ COMPLETED 2026-07-05.** Send telemetry events with `metricType: "balance"` or `"limit"` to the API Usage Monitor to track tech account caps and credits. Telemetry wired into Alpaca and Robinhood `getPortfolio` calls. Lint, tsc, and tests green.
- **Eliminate redundant fill-history fetch/replay (AG, M) — ✅ COMPLETED via PR #850 (merged 2026-07-05).** Fills fetched once in `runStrategyOnce` and passed down through all scorecard and sizing calls, eliminating up to 8 duplicate DB queries per run. Unified unit test added to `test/performance.test.ts` to assert that prefetched fills are used and DB query counts are bypassed. Lint 0, tsc clean, Next.js build green.
- **PRs #816 / #819 / #820 / #822 - CLAUDE planned-backlog train: prompt-safety fencing, usage-budget
  advisory wiring, durable due-jobs substrate, HyDE+multi-query retrieval (CLAUDE). → DEPLOYED to
  production 2026-07-06 as part of the `7b5450fe` publish (see Deployed section top).** All merged to
  `main` 2026-07-05 (verify/smoke/gitleaks green, auto-merge; squashes `041b73b2`/`f28322fe`/
  `e90db1a8`/`d97b7c71`). Every lane: triage-first (6-agent pass found 3 of 7 claimed rows already
  done — RAG eval harness + prereqs = PRs #297/#299, prompt eval + PROMPT_VERSION = 2026-07-01
  landing, per-user/day LLM ceiling = PR #316), then build (Sonnet lanes, frontier for money-path
  prompts), then independent adversarial review (3 blockers caught pre-merge: budget downgrade
  persistence leak via cap-breach setPolicy, due-jobs stale-merge lost-update vs worker rows,
  HyDE fail-closed fan-out), review-fix commits, sequential land.sh gates (suite grew
  2577→2587→2619). #816: Bull/Bear untrusted blocks fenced w/ data-not-command clauses,
  deterministic injection-attempt + evidence-age receipts (advisory, never blocks),
  reflection_summary out of SYSTEM, learned-fact provenance inline, STRATEGY_PROMPT_VERSION 1.5.0.
  #819: usage_budget_status receipt + budgetAdvisory prompt line every configured run;
  USAGE_BUDGET_ENFORCE opt-in downgrade/skip w/ receipts, run-scoped only (never persisted);
  downgrade reaches Bear + reflection. #820: due_jobs table (migration v11) + db-jobs.ts
  lease/reclaim queue + scheduler-tick worker guaranteeing 15m/1h outcome samples survive downtime;
  due_jobs in account-deletion scope. #822: RAG_MULTIQUERY/RAG_HYDE (default OFF, byte-identical
  off-path) evidence-derived variants + HyDE passages RRF-fused into filings retrieval, budget-gated,
  fail-open per-variant w/ single-query fallback. Rollout notes: 2026-07-05-prompt-safety-fencing /
  -usage-budget-advisory-wiring / -durable-due-jobs / -hyde-multiquery-retrieval.md.

- **PR #811 - Console live-data build-out (CODEX, L).** Merged to `main` 2026-07-05T07:37:48Z
  (verify/smoke/gitleaks green, auto-merge). _2026-07-05 (CLAUDE next-wave): CORRECTION — this row
  was previously logged under In Progress as "PR #811 open, squash auto-merge enabled"; #811 has
  since merged (verification quartet was green pre-merge). Moved to Completed._ Worktree
  `/Users/jay/.codex/worktrees/socratic-console-live-data`, branch `codex/console-live-data`.
  Consumes `/api/events/stream` in the console data layer, surfaces live connection/freshness
  state, and upgrades overview mark-to-market / risk utilization / open positions blotter /
  intraday equity view using existing components first. Verification pre-merge: `npm run lint
  -- --quiet`, focused live-data vitest (`4`), full `npm test` (`257` files / `2510` tests),
  `npm run build`, `npx tsc --noEmit` (after build regenerated `.next/types`). Keepout: settings,
  approvals, Monet risk, Claude memory/RAG, unrelated tooltip sweeps respected.

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
- **Mobile console width overflow — autonomy-desk home (CLAUDE cloud, branch
  `claude/mobile-console-width-overflow`) — PR open (#992).** Owner-reported: on mobile, every section
  after the Live-thesis hero rendered wider than the viewport (content clipped off the right edge).
  Root cause: the lower content grid in `app/console/page.tsx` fell back to an implicit `auto`
  (min-content) track on mobile with `min-width:auto` column items, so the 7-column `PositionsCard`
  table (nowrap headers, ~610px min-content) stretched the whole column and defeated its
  `overflow-x-auto` wrapper. Fix: `grid-cols-1` on the wrapper + `min-w-0` on both column children
  (mirrors the hero's existing shrink-safe pattern; layout `<main>` was already `min-w-0`). Verified
  tsc/lint/build clean + empirical 390px before/after with the real `console.css` (627px overflow →
  contained; table now scrolls inside its card). See
  `docs/rollouts/2026-07-06-mobile-console-width-overflow.md`.
- **Coolify/Hetzner hosting migration + Cursor promoted to peer agent lane** (CLAUDE cloud,
  branch `claude/llm-apps-m5-resource-optimization-n9w5ax`) — **IN PROGRESS 2026-07-06.**
  Self-hosted Coolify (open-source PaaS) stood up on a Hetzner CX23 behind `jays.services` to
  offload local agent/dev-server resource usage from the owner's 16GB M5 MacBook Air. API
  token verified working (Coolify 4.1.2). `agent/antigravity` and `agent/cursor` branches
  created (didn't exist before). `AGENTS.md`'s outdated "Cursor: not a 4th agent lane" section
  corrected — Cursor now runs background/agent-mode work on DeepSeek as a full peer lane
  (port 4104, `cursor.jays.services`) while keeping its human-review-seat role too. **Next:**
  create the Coolify project + connect the repo, deploy 6 preview-lane apps (main +
  agent/claude/codex/antigravity/monet/cursor), then migrate `socratictrade.com` production
  onto the same box (owner-confirmed decision, accepting the noisy-neighbor risk on a 4GB
  box) — production needs real secrets transfer, DB migration/cutover plan, and Coolify
  Backups enabled (unlike the preview apps). See
  `docs/rollouts/2026-07-06-coolify-migration.md`.

- **Pre-policy vetoes advisory-overridable (CLAUDE, #799 follow-up) — merged PR #814 (verify+smoke green).**
  _2026-07-05 (CLAUDE next-wave): CORRECTION — this row's text already said COMPLETED/merged but it
  was physically still sitting under the In Progress heading; relocated to Completed (issues mirror
  keys off section classification, so a correct-text row in the wrong section was still showing as
  open)._ Branch `claude/veto-advisory-overridable`, isolated worktree. Deterministic bear filter
  (Rules 3/4) + approval-time Red Team veto now TAG candidates with `preVetoReasons` instead of
  dropping → folded into the sized PolicyDecision → #799's `resolveSocraticOverride` (openings,
  socraticOverrideMode + cap). Rule 1 stays hard; Rule 4 overridable-but-flagged for owner
  ratification. FIX #1 (no counterfactual on override path — protects getRedTeamEfficacy) / #2b
  (durable deterministic_bear_veto audit) / #3 (propose-mode pre-route before sell-to-fund).
  Independent 3-lens adversarial verify caught + fixed 2 money-path bugs the green suite missed
  (severe phantom-funding-sell via `preVetoTaggedOpeningWillPlace`; free-text hard-gate
  misclassification via `isHardGateReason` prefix short-circuit), both regression-tested. Gate:
  tsc/lint-0/258 files-2540 tests/build. OVERLAP: unlanded `claude/redteam-policy-aware-routing`
  touches the same strategy.ts Red-Team branch — coordinated in-channel, rebase at land. See
  `docs/rollouts/2026-07-05-pre-policy-veto-advisory.md`.

- **Full-suite test determinism: de-flake order-confirmation-status + chat-orchestrator-search-knowledge (CLAUDE, S) — merged PR #812.**
  _2026-07-05 (CLAUDE next-wave): CORRECTION — same class of issue as the row above: text said
  COMPLETED/merged but the row was still under In Progress; relocated to Completed._ Worktree
  `~/apps/trading-claude`, branch `agent/claude`. Root causes measured: (1) `executeProposal` tests
  ran a REAL market scan (Nasdaq screener + Yahoo, 6-8s abort timeouts + 429 backoff) — ~12-13s/test
  solo, past 30s under 4-worker load; (2) chat-orchestrator's first test paid the ~15s orchestrator
  module-graph import inside its own 20s testTimeout. Fix: partial-mock `scanMarket` at the
  market.ts boundary (importOriginal keeps the rest real) in order-confirmation-status +
  approval-lock (same class — its 2026-06-21 fix only padded timeouts); hoist the orchestrator
  import into `beforeAll(…, 120_000)`. After: reject/accept tests 12.9s/11.9s → 0.5s/0.02s;
  orchestrator first test 15.5s → 1ms; full suite 256 files / 2506 tests green in 20.77s wall. No
  src/ changes. See `docs/rollouts/2026-07-05-full-suite-test-determinism.md`.

- **Guardrails → overridable preferences (denylist) (MONET risk lane) — merged PR #799.**
  _2026-07-05 (CLAUDE next-wave): CORRECTION — same class of issue: text said COMPLETED/merged but
  the row was still under In Progress; relocated to Completed._ Worktree `~/apps/trading-monet`,
  branch `monet/guardrail-overridable-denylist`. Owner directive: the ONLY hard rules are the
  account boundary + physical/broker/regulatory/accounting impossibilities; every other policy
  block is a light preference the agent may self-override with a logged `autonomyOverride` thesis.
  Inverted the Socratic override classifier from an allowlist to a DENYLIST: new
  `HARD_GATE_REASON_PATTERNS` + `isHardGateReason` source-of-truth in `policy.ts` (risk engine);
  `socratic-runtime.ts` `overrideableReason` = `!isHardGateReason`. Reclassified short-stop-required
  / bracket-required / policy-level short-disabled from hard→overridable; unlisted/new gates now
  default overridable instead of silently hard. Advisory-only (nothing auto-overrides;
  broker/account/regulatory hard gates untouched). New `test/hard-gate-classification.test.ts` pins
  the full matrix. Cross-lane touch to `socratic-runtime.ts` (CLAUDE's file) coordinated
  in-channel. Follow-ups: extend override to exits; make pre-policy vetoes (bear filter, Red Team)
  advisory. See `docs/rollouts/2026-07-05-guardrail-denylist-overridable-preferences.md`.

- **PR #807 - Approvals triage upgrades + alert center (CODEX, M).** Merged to `main`
  2026-07-05 (verify/smoke/gitleaks green, auto-merge). Adds pending-approval
  sort/filter, safe bulk non-LIVE actions via existing proposal endpoints, and a console
  alert center over existing notifications/activity data. Production deployment remains
  separate.
- **PR #694 - Effort-issues sync secondary-rate-limit hardening (CLAUDE, S).** Merged to `main`
  2026-07-05 (verify/smoke/gitleaks green, auto-merge). `scripts/sync-effort-issues.py` now
  survives GitHub secondary rate limits: 2.5s creation throttle, Retry-After/exponential-backoff
  retries under a bounded 300s per-run budget, and exit-0 "PARTIAL SYNC - resume on next run"
  summary on budget exhaustion (sync is idempotent). Propagated verbatim to
  congress-trading-shared (PR #27), api-usage-monitor (PR #38), and Congress.Trade (PR #162)
  - all merged 2026-07-05. Codex-review refinements (issue listing inside partial handling,
  server Retry-After honored uncapped, 1s update throttle) merged back via Socratic PR #796 and
  re-propagated (congress-trading-shared #29+#30, api-usage-monitor #40+#41, Congress.Trade in
  #162). All four repos' effort-sync workflows verified green post-merge.
- **PR #449 - Regime-enum adoption inside the risk gates (MONET risk lane).** Merged to `main`
  2026-07-04 (verify + smoke green, auto-merge). The three deterministic risk gates now classify the
  persisted regime label through the shared typed `MarketRegime` source of truth (`market-regime.ts`)
  instead of three independent substring/`startsWith` rules: crisis/inverted cap (`policy.ts`),
  bear-filter risk-off veto (`strategy.ts` `deterministicBearFilter` — the in-code comment that
  reserved this site "for the risk lane (Monet)" is now resolved), and the escalation gate
  (`regime-watch.ts` `isEscalationRegime`, also feeding the dissent trigger). The "one-line adoption"
  w1-regime-data (#368) exported the typed predicates + pinned `test/market-regime.test.ts` for.
  Correctness hardening only — canonical-label behavior byte-identical (incl. the Cautious-Inverted
  asymmetry); non-canonical free-text labels now read non-escalating instead of accidentally
  substring-matching. Imports `./market-regime` (not `./macro`) to survive the whole-module macro mock
  in `test/regime-watch.test.ts`. New gate-level regression `test/regime-gate-adoption.test.ts` + a
  `policy.test.ts` hardening case. Gate green: tsc/lint-0/2465 tests/build. KEEPOUT respected: no
  mem/RAG (CLAUDE) or console/UI (CODEX) files touched. See
  `docs/rollouts/2026-07-04-regime-enum-risk-gate-adoption.md`.

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
- **Bump shared dependency in agentic-trading and Congress.Trade to ^1.3.0 and fix HTTPS lockfile (AG) — IN PROGRESS 2026-07-06.** Fixing CI/CD `check-pin` failures by syncing both repositories' `package.json` specifications to the exact same version, and normalizing `package-lock.json` to use `git+https` instead of `git+ssh` to prevent tokenless environment crashes.
- **CLAUDE next-wave: RAG retrieval-quality + corpus-integrity cluster (CLAUDE) — COMPLETED,
  5 PRs merged 2026-07-06.** Follows the merged+deployed CLAUDE train (#816/#819/#820/#822 → prod
  `7b5450fe`). Throwaway worktree session (seat CLAUDE per AGENT_SEAT pin), `claude/*` lanes off
  `main@fc4b179e`, triage-first then parallel build/review/land. Of the 9-row triage scope, 5 lanes
  were built/reviewed/fixed/landed same day (see their own Completed rows below for detail):
  typed retrieval-status receipt (**PR #970**, merged 2026-07-06), RAG golden-eval episodic
  expansion (**PR #973**, merged 2026-07-06), held-position retrieval scope (**PR #974**, merged
  2026-07-06), per-run corpus-coverage receipt (**PR #977**, merged 2026-07-06), and persist
  full retrieved candidate pool (**PR #979**, merged 2026-07-06). The remaining 4 triage rows
  resolved without new PRs — no code changed for these, so they were never split into their own
  board rows; disposition of each, triaged 2026-07-06:
  - "Fail-closed as-of strict mode for undated chunks" (triage 2026-07-06: already done —
    `VECTOR_ASOF_STRICT` + rankPool drop-count audit + `test/vector-db-asof-strict.test.ts`).
  - "Fix train/serve embedding text skew" (triage 2026-07-06: already done — see `VECTOR_EMBED_CLEAN_TEXT`,
    shipped 2026-07-01 per `PLAN.md`'s R17/RAG-backlog entry and `docs/rollouts/2026-07-01-rag-backlog.md`).
  - "Verify decision-memory re-index covers outcome/lesson writes" (triage 2026-07-06: already done
    — outcome + lesson writers both call `indexSocraticDecisionMemory` (`src/lib/db-socratic.ts`,
    `src/lib/strategy.ts`)).
  - "Server-side numeric as-of epoch filter in Pinecone" (2026-07-06: DEFERRED — needs an
    ingest-time numeric-epoch backfill on existing vectors + a fail-open-vs-fail-closed owner
    decision before the server-side filter can replace post-fetch as-of).
  KEEPOUT held throughout: MONET risk gates, CODEX console/UI, AG data-provider lanes untouched.
  Session rollout: `docs/rollouts/2026-07-06-claude-nextwave-rag.md`.
- **Codex autofix storm guard (CODEX, workflow/fleet-infra) — DONE-local 2026-07-05; awaiting push/PR.**
  Scope: reduce `codex-autofix.yml` storm odds/frequency by running the autofix loop once per
  Codex submitted review plus manual `workflow_dispatch`, not on every Codex inline/issue
  comment. Touch workflow callers only in clean Codex worktrees; preserve manual dispatch and
  round-cap behavior.

- **Harden HMAC Security & Persistent Idempotency for webhooks (AG, M) — moved back from Completed
  2026-07-05 (CLAUDE audit-c3).** PR #854 (`antigravity/socratic-webhooks`) is OPEN,
  mergeStateStatus BLOCKED, all CI green, reviewDecision empty, no auto-merge armed. Blocked by the
  main-protection ruleset needing review/thread-resolution — not a code issue. action=land-it; see
  the new "Resolve main-protection ruleset review gate" Planned row below for the structural fix.


## 🔨 In Progress

- **Console intro animation (candlestick page-load splash)** (CLAUDE cloud session, branch
  `claude/socratic-trade-logos-p0hxk7`) — **pushed; PR open**. New
  `app/console/components/intro-canvas.tsx` (pure Canvas, responsive, any-bg, once/session,
  click-skip, reduced-motion-safe) wired into `shell.tsx` as the console first-load splash:
  waving chart -> candles fly -> big SOCRATIC/TRADE (formed candles + colours, ripple only — no
  reshape/"flip") -> shrink to top-left header. Header is a varied candlestick ticker (12-unit
  green-biased walk marching one column/sec; every candle its own red/green, no colour blocks; no
  wave); speckle fixed by overlapping flying candles onto natural strokes + body width tied to
  column count. Letter-stem evenness fixed. tsc/lint/build green + center & header driven live.
  Reference `docs/branding/intro-live.html`. Next (opt): persistent ticking header brand. See
  `docs/rollouts/2026-07-06-console-intro-animation.md`.
- **HyDE + evidence-derived multi-query retrieval for filings RAG** (CLAUDE, worktree
  `~/apps/trading-wt-hyde`, branch `claude/hyde-multiquery`) — **IN PROGRESS 2026-07-05, review
  fixes applied same day (second commit).** New `src/lib/rag/multi-query.ts`: pure
  `deriveQueryVariants()` (2-4 facet sub-queries from evidence/sector/dominant-factor) +
  `generateHydePassages()` (one cheap fail-open LLM call, HyDE passages, salience-llm.ts pattern).
  Two flags `RAG_MULTIQUERY`/`RAG_HYDE` (+`RAG_HYDE_MODEL`), both default OFF — **not
  independent**: `RAG_HYDE` alone is a no-op without `RAG_MULTIQUERY` (docstring fixed in review
  pass). `vector-db.ts` `RetrieveOptions.queries?: string[]`: per-query embed+match (now including
  the original `query` alongside variants), RRF-fused (`rag/hybrid.ts` `rrfFuse`) into the existing
  `rankPool` pipeline unchanged. `strategy.ts` filings-RAG block wired behind both flags +
  budget-degrade check; flags-off is byte-identical (pinned by a dedicated regression test).
  **Review-fix pass (same day):** fixed a BLOCKER — the multi-query fan-out was fail-CLOSED (one
  variant's rejected Voyage/Pinecone call discarded every other variant's results via a bare
  `Promise.all`, returning `[]` instead of falling back to the single-query path) — now each
  fan-out call is caught individually and an all-fail case falls back to plain single-query
  retrieval. Also fixed: first-occurrence-wins id resolution could keep a lower cosine score (now
  higher-score wins); HyDE's endpoint/model could disagree (endpoint resolved from
  `policy.llmModel`, model sent was the separate `hydeModel()` — could route an OpenAI model to
  `api.anthropic.com` under an Anthropic policy; now resolved coherently, and non-OK responses now
  audit `rag_hyde_failed`); HyDE spend wasn't gated on the daily LLM budget (now gated via
  `isOverLlmBudget`, read-only import from `llm-budget.ts`). Tests: 34 total across the 3 new files
  (`test/rag-multi-query.test.ts` 14, `test/rag-hyde.test.ts` 12,
  `test/rag-multi-query-retrieval.test.ts` 8). Verification: tsc clean, focused RAG/strategy suite
  green (33 files / 384 tests). See `docs/rollouts/2026-07-05-hyde-multiquery-retrieval.md`
  (incl. its "Review fixes" section). Local-worktree HARD RULE: commit only, no push/PR — central
  landing operator handles integration with `origin/main` (7 commits ahead incl. sibling lanes
  `claude/due-jobs-substrate`, `claude/prompt-safety-fencing`).
- **MONET 5 risk lanes — reclaimed from the handback (MONET) — IN PROGRESS 2026-07-05.** The five risk rows handed back to MONET (board "MONET risk-row handback"): `monet/multi-signal-regime-scorer` (credit spreads + VIX term structure + breadth → severity), `monet/vol-targeting-portfolio-heat` (continuous vol-target exposure taper + portfolio-heat budget), `monet/correlation-event-stress-gates` (EWMA/downside correlation gate + earnings/macro blackouts + pre-trade stress), `monet/fractional-kelly-sizing` (downside-dispersion fractional Kelly), `monet/redteam-policy-aware-routing` (Red-Team unavailable → policy-aware routing timeout/429/malformed; builds on merged #814). All advisory/owner-overridable (never a cage), new-module-first (minimal policy.ts/strategy.ts diffs), built off current `main` on `monet/*` branches (the old empty `.claude/worktrees/monet-*` `claude/*` branches are NOT reused). Running a 5-lane design team, then implementing lane-by-lane with builder + adversarial verify, one PR per lane via `land.sh`. The old CLAUDE-pickup "Risk-lane implementation train" row below is superseded by this handback reclaim.

- **Codex Cloud Slack + effort-log readiness across all four apps (CODEX, shared fleet-infra) —
  DONE-local 2026-07-05; awaiting owner approval to push/open PRs.** Scope: audit/standardize Codex Cloud repo-visible setup so remote
  Codex sessions can read `docs/EFFORT-LOG.md` and use #agent-sync with the configured
  `SLACK_AGENT_NAME`, `SLACK_CHANNEL_ID`, `SLACK_PROJECT`, and runtime token/env settings. Keep
  work out of dirty Cursor/Monet worktrees; reuse/adapt the closed PR #367 Slack helper rather than
  creating a competing Slack Socket Mode client. Cross-app rows mirrored in the other live boards.
- ~~**PR #808 - Cursor session: P0 checkRegimeFlip RMW fix + P1 backlog exhaustiveness (CURSOR)**~~
  _2026-07-05 (CLAUDE audit-c3): MOVED TO COMPLETED — origin-verified #844 (squash `ebcf6a23`) is
  merged to `main`, confirmed containing the P0 per-user regime keys, security headers, and
  LLM_SPEND_CEILING. Full history relocated to the Completed section under "PR #844 -
  pr805-remediation" (see there); this In Progress placeholder kept only as a pointer per
  never-delete-a-row._

- **Design-sync: Socratic Trade UI Kit -> claude.ai/design (CLAUDE) — IN PROGRESS 2026-07-05, PR open.** Branch `agent/design-sync-uikit`, isolated worktree off `origin/main` (primary worktree was busy with a live Cursor session). 30 app primitives (12 `ui` + 18 `console`, from `app/ui/primitives.tsx` + `app/console/ui/primitives.tsx`) converted + uploaded to claude.ai/design so the design agent builds with the real components. Render check 30/30 clean, conventions header shipped. Uploaded to 2 owner accounts (projects `0a962679…`, `1da8546c…`). Additive only: `.design-sync/` inputs + one `.gitignore` block, no app source changed. Rollout: `docs/rollouts/2026-07-05-design-sync-uikit.md`.
  _2026-07-05 (CLAUDE audit-c3): status re-verified — PR #818 is OPEN, mergeStateStatus BLOCKED, all
  checks SUCCESS (verify/smoke/gitleaks/classify green x2), auto-merge armed but not firing,
  reviewDecision empty. Blocked purely by the main-protection ruleset gate (conversation-resolution/
  review), not by code. Open since 07-05 13:27, 2 commits ahead, docs-only, low risk. action=land-it;
  see the new "Resolve main-protection ruleset review gate" Planned row below for the structural fix._
- **Risk-lane implementation train: the 5 remaining MONET-tagged lane rows (CLAUDE pickup) — IN PROGRESS 2026-07-05.**
  _2026-07-05 (CLAUDE): row re-attributed MONET→CLAUDE same day — owner confirmed this session's
  seat is CLAUDE (the monet-* worktree names are WorktreeCreate-hook artifacts); branches renamed
  `monet/*`→`claude/*` before any push. Cross-seat pickup of MONET-tagged rows, heads-up posted
  in-channel; real MONET seat can ping to take lanes back._
  Parallel build in per-lane worktrees under `/Users/jay/Code/Socratic.Trade/.claude/worktrees/monet-*`
  (hook-artifact dir names kept), serial landing via `land.sh` (one PR per lane). Branches: `claude/redteam-policy-aware-routing`
  (Red-Team/Bear unavailable → policy-aware routing for ALL failure modes: timeout/429/malformed-JSON,
  propose→human-approval, autonomous→de-risk-only + RED TEAM FAILED flag), `claude/vol-targeting-portfolio-heat`
  (continuous vol-targeting exposure taper + portfolio-heat budget, advisory/owner-overridable),
  `claude/correlation-event-stress-gates` (EWMA/downside correlation gate + earnings/macro event blackouts +
  pre-trade stress scenario — advisory receipts, never cages), `claude/fractional-kelly-sizing`
  (downside-dispersion-aware fractional Kelly on realized payoff), `claude/multi-signal-regime-scorer`
  (credit spreads + VIX term structure + breadth → severity feeding caps/learning). New-module-first
  pattern to minimize shared-file diffs; policy.ts/strategy.ts integration points kept minimal and
  resolved at landing. Keepout respected: CODEX console/UI lanes, CLAUDE memory/RAG + test-determinism
  files (test/order-confirmation-status.test.ts, test/chat-orchestrator-search-knowledge.test.ts,
  test/approval-lock.test.ts), AG health-routing files, cursor/session-2026-07-05 files. Cross-lane
  touches to `socratic-runtime.ts` (CLAUDE file) coordinated in-channel if needed.
- **CLAUDE planned-backlog implementation train: 6-row primary lane + prompt-safety group (CLAUDE, second session) — COMPLETED 2026-07-05: ALL FOUR PRs MERGED to main — #816 prompt-safety-fencing (`041b73b2`), #819 usage-budget-advisory-wiring (`f28322fe`), #820 due-jobs-substrate (`e90db1a8`), #822 hyde-multiquery (`d97b7c71`). Repo-mirror closeout docs + session rollout note landed as PR #863 (MERGED; also deduped stale duplicate In-Progress mirror rows for these four). Train fully closed.**
  Session worktree `/Users/jay/Code/Socratic.Trade/.claude/worktrees/monet-xenodochial-dirac-26f036`
  (throwaway; seat confirmed CLAUDE by owner this session — the monet-prefixed worktree/branch name is a
  WorktreeCreate-hook artifact; all work lands on `claude/*` branches off `origin/main`, own PRs, landed
  sequentially). Scope, triage-first then parallel subagent lanes: (1) usage-budget Phase-2 wiring into
  `runStrategyOnce` + per-user/day token-budget ceiling at trigger/strategy entry; (2) RAG
  retrieval-quality eval harness WITH its prerequisites (golden-set anti-leakage/hard-negative lint,
  retrieval regression net); (3) Bull/Bear prompt eval + PROMPT_VERSION harness; (4) HyDE +
  evidence-derived multi-query retrieval; (5) durable due-jobs substrate; (6) prompt-safety CR-H group
  (fence untrusted-text fields in money-path prompts, injection-attempt detection receipts,
  reflection_summary out of SYSTEM into fenced block, learned-fact provenance inline, evidence-age
  anomaly receipts). KEEPOUT respected: MONET risk files, CODEX console/UI, AG lanes; NOT touching
  in-progress CLAUDE rows owned by other sessions (agent/claude de-flake, Wave-3 lanes, tokenless-dep,
  ci-hybrid-runner). Note: `~/apps/trading-conflict-fix` (`claude/llm-budget-reservation`, stale
  2026-07-01) is the built-but-unwired substrate item (1) wires up — not an active claim.
  **TRIAGE RESULT 2026-07-05 (6-agent read-only pass, file:line evidence):** rows (2) RAG eval harness
  + both prerequisites = ALREADY DONE (PRs #297/#299, 29 tests re-verified green this session); row (3)
  prompt eval + PROMPT_VERSION = ALREADY DONE (2026-07-01 money-path landing, `STRATEGY_PROMPT_VERSION`
  stamped on every trade_proposals row + offline eval `npm run eval:strategy-offline`); per-user/day LLM
  ceiling half of row (1) = ALREADY DONE (PR #316 reservation + hardening series; the triggers.ts
  "deferred" comment refers to run-COUNT caps, not the LLM budget). Remaining REAL work = 4 lanes, now
  WIP in parallel worktrees off main@d3c69c36: `claude/usage-budget-advisory-wiring`
  (~/apps/trading-wt-budget-advisory — BudgetStatus as advisory prompt context + receipt per owner's
  advisory-guardrails philosophy; USAGE_BUDGET_ENFORCE stays an opt-in owner preference),
  `claude/hyde-multiquery` (~/apps/trading-wt-hyde — flag-gated default-OFF, reuses rrfFuse/query-embed
  LRU/budget gates), `claude/due-jobs-substrate` (~/apps/trading-wt-due-jobs — due_jobs table +
  db-jobs.ts + scheduler-tick worker + outcome-engine/counterfactual intraday enqueue),
  `claude/prompt-safety-fencing` (~/apps/trading-wt-prompt-safety — fence untrusted prompt blocks,
  deterministic injection-attempt receipts never blocks, reflection_summary out of SYSTEM into fenced
  data, learned-fact provenance inline, evidence-age receipts; bumps STRATEGY_PROMPT_VERSION).
  **Sub-lane update 2026-07-05 (`claude/due-jobs-substrate`):** implementation complete, verified
  locally, committed — awaiting sequential landing. `due_jobs` table (migration v11, `src/lib/db.ts`)
  + `src/lib/db-jobs.ts` (lease/reclaim claimable queue); `counterfactual-learning.ts` +
  `outcome-engine.ts`'s `measureCase` enqueue `sample_intraday_horizon` jobs once a case's basis
  resolves; new `drainDueIntradaySampleJobs` worker drains through the same merge/write path the
  inline `samplableNow` path uses (documented in `mergeHorizonRows`, no duplicate rows); one
  fire-and-forget call added to `scheduler.ts` `tick()`. Tests: `test/db-jobs.test.ts` (10) +
  `test/outcome-engine-due-jobs.test.ts` (5), tsc clean. See
  `docs/rollouts/2026-07-05-durable-due-jobs.md` in the worktree.
  **LANDING PROGRESS 2026-07-05:** prompt-safety-fencing adversarially REVIEWED (no blockers;
  excerpt-cap + fence-escape-pattern + feedback-loop-guard fixes applied as `2b5328d7`) →
  **PR #816 MERGED to main 2026-07-05 (`041b73b2`, verify/smoke/gitleaks green)** — lane 1 of 4
  COMPLETE; merged cleanly over main's pre-policy-veto-advisory landing (#814). Seat resolution
  settled per owner + AGENT_SEAT pin: this session is CLAUDE; `claude/*` prefixes stand, no renames.
  budget-advisory → **PR #819 MERGED to main 2026-07-05** (gate 2587 tests / 261 files; cross-branch
  semantics with #816 verified — budgetAdvisory + fenced reflectionSummary coexist; runPolicy
  threading intact). due-jobs (28614548 review fixes + df8cc7d1 account-deletion coverage; v11
  migration confirmed unique) → **PR #820 gate green, auto-merge armed** (one post-#819 EFFORT-LOG
  keep-both conflict resolved as merge 97aa25c6). hyde-multiquery (c1fb2965 review fixes) →
  **PR #822 gate green (2619 tests / 264 files), auto-merge armed**. FINAL: #820 MERGED (`e90db1a8`)
  and #822 MERGED (`d97b7c71`) 2026-07-05 after one keep-both EFFORT-LOG re-merge each (97aa25c6,
  de962089). All four lanes on main; repo-mirror closeout docs PR in flight. due-jobs adversarial review
  found 1 blocker (stale-merge lost-update: inline outcome pass can erase worker-written horizon rows
  at `writeSocraticDecisionOutcome`/`markSkippedCounterfactualMatured`) + 2 minors (claimant-fenced
  terminal transitions; dead 'failed' status) — **all 7 findings FIXED as of 2026-07-05 (2nd commit
  on `claude/due-jobs-substrate`, HEAD `4b105e5a` not amended):** write-time re-merge in
  `writeSocraticDecisionOutcome`/`markSkippedCounterfactualMatured`/
  `markSkippedCounterfactualUnresolvable` (idempotent via `mergeHorizonRows`'
  existing-terminal-wins); claimant-fenced `completeDueJob`/`failDueJob`/`markDueJobUnresolvable`
  (`db-jobs.ts`); drain receipt's `failed` renamed `erroredRetried` + dead `'failed'` `DueJobStatus`
  value/CHECK removed; worker's `caseId.split(":")` counterfactual lookup replaced with an exact
  `runId`+`horizonDays`-keyed lookup (`getSkippedCounterfactualByRunSymbolHorizon`); `enqueueDueJob`
  docstring qualified (idempotent only with `dedupeKey`). tsc clean; 33/33 targeted tests green;
  lint 0 errors; build succeeds; full suite 2529/2530 (1 pre-existing unrelated
  account-deletion-coverage failure re: `due_jobs` missing from deletion coverage, confirmed via
  `git stash` to predate the fix commit, flagged as a separate follow-up task). See
  `docs/rollouts/2026-07-05-durable-due-jobs.md`'s "Review fixes" section. Ready for the next
  landing slot. budget-advisory built green (`98123f3c`; adds optional backward-compat
  policyOverride param to red-team.ts debateProposal so enforced downgrades reach Bear) — adversarial
  review found 1 BLOCKER (enforcement block mutated the shared `policy` object in place, so a
  same-run cap-breach demotion's `setPolicy({ ...policy, strategyAuthority: "propose" })` would have
  persisted the transient model downgrade permanently, contradicting the "in-memory only" contract) +
  3 minor + 1 nit — **all fixed in a second commit same day (not amended):** replaced the mutation
  with a separately-carried `runLlmOverride`/`runPolicy` never passed to
  `setPolicy`/`autoRevertOnCapBreach`; narrowed the enforcement try/catch so a post-audit throw in the
  skip path can't fall through into the full LLM path; threaded the downgrade into
  `generateReflectionSummary` (outcome-engine's fire-and-forget lesson pass left as a documented
  intentional exemption); reused the already-fetched budget status instead of double-fetching;
  extended the downgrade test to also assert the Red Team request body's model. tsc clean; targeted
  vitest 6 files / 36 tests green; full suite 258 files / 2521 tests green; build clean. See
  `docs/rollouts/2026-07-05-usage-budget-advisory-wiring.md`'s "Review fixes" section. Ready for the
  next landing slot.
  hyde-multiquery built green (`7e075534`; 33 files / 381 focused tests) — adversarial review found
  1 blocker (fan-out fail-closed on a per-variant Voyage/Pinecone rejection, contradicting the
  module's own fail-open contract) + 4 minor + 1 nit; all fixed in a second commit same day
  (per-variant catch + single-query fallback on all-fail, higher-score id resolution, HyDE
  endpoint/model coherence + non-OK audit, HyDE daily-budget gate, primary query included in
  fan-out); tsc clean, focused suite 33 files / 384 tests green — see
  `docs/rollouts/2026-07-05-hyde-multiquery-retrieval.md`'s "Review fixes" section. Landing
  strictly sequential.

- ~~**Admin connection health and backend-failure notification pass (AG, L)**~~
  _2026-07-05 (CLAUDE audit-c3): MOVED TO COMPLETED — origin-verified #844 (squash `ebcf6a23`)
  merged to `main` and contains this AG connection-health slice alongside the Cursor P0/P1 commit.
  #805 (`cursor/session-2026-07-05`) is CLOSED, superseded by #844. Full history relocated to the
  Completed section under "PR #844 - pr805-remediation"; this In Progress placeholder kept only as
  a pointer per never-delete-a-row.

- **Accessible tooltip/popover primitive everywhere (CODEX, S) — IN PROGRESS 2026-07-04.** Worktree
  `/Users/jay/.codex/worktrees/socratic-console-tooltip-primitive`, branch
  `codex/console-tooltip-primitive`. Focused slice for issue #474: reusable tooltip/popover
  primitive in `app/console/ui/primitives.tsx` plus a high-value console-native `title` replacement
  pass across controls/metrics/cells. Keepout: Monet risk files, Claude memory/RAG files,
  workflows, AGENTS, Slack scripts, and unrelated lanes. Verification 2026-07-05: tsc clean,
  `npm run lint -- --quiet` clean, and `git diff --check` clean. Waiting for scan-column PR #806
  to land before final merge-forward/push because both touch `app/console/scan/scan-table.tsx`.
  _2026-07-05 (CLAUDE audit-c3): CORRECTION + REASSIGNMENT — this row said "verified 2026-07-05,
  waiting on #806 to land"; #806 merged 15:01Z, but `git ls-remote --heads origin
  codex/console-tooltip-primitive` returns 0 — the branch was NEVER pushed to origin. The work
  exists only in a local Codex worktree, and Codex is now quota-capped until Jul 8 18:10 CT, so it
  cannot push/finish it. Unverifiable/stranded as CODEX-owned. **Reassigned CODEX -> AG**
  (action=reclaim-and-finish from the new owner). AG: the implementation intent (issue #474) is
  fully specified above — recreate/finish on a fresh `agent/antigravity`-lane branch since the
  original Codex worktree content isn't recoverable from origin._
- **Coach chat -> framework primitives (CODEX, M) — IN PROGRESS 2026-07-04.** Worktree
  `/Users/jay/.codex/worktrees/socratic-coach-framework-primitives`, branch
  `codex/coach-framework-primitives`. Focused slice for issue #473: decision-trace coach-note POST
  can optionally promote into lesson/framework primitives, framework review now carries explicit
  rewrite/ownerResponse semantics, and the trace renders linked run metadata when available.
  Keepout: live-data/settings/tooltip lanes, Monet risk files, Claude memory/RAG files, workflows,
  AGENTS, and Slack scripts. 2026-07-05 update: merge-forwarded to `origin/main` @ `0bfa4f1e`;
  verification green in the branch worktree — `test/socratic-db.test.ts` (3 tests), `tsc`,
  quiet lint, full `npm test` (256 files / 2507 tests), and `npm run build`. PR #810 is open and
  squash auto-merge is armed pending `verify`.
- **Scan table column customization parity (CODEX, M) — IN PROGRESS 2026-07-04.** Worktree
  `/Users/jay/.codex/worktrees/socratic-scan-column-customization`, branch
  `codex/scan-column-customization`. Scope: bring `/console/scan` to legacy dashboard parity for
  column visibility, ordering, reset, and saved browser-local state; allow only tightly related
  ticker-drawer parity if the scan surface needs it. Keepout: no broad settings/approvals/live-data/
  coach/tooltip conversions in this lane. PR #806 open with auto-merge enabled; merge-forward
  through PR #807 pushed 2026-07-05 as `63c69d05`; later blocker identified as unresolved Codex
  review thread and addressed locally by pinning `symbol` as the first/sticky column during
  saved-state sanitization and reordering; second review follow-up defers saved `localStorage`
  column state until after mount to avoid hydration mismatch.
  Verification green: focused scan-column test (4), lint 0 errors / 308 existing warnings,
  land.sh tsc clean, full suite 2508 tests / 256 files, build green. Review follow-up verification:
  focused scan-column test (4), TypeScript clean, `git diff --check` clean; hydration follow-up
  verification: focused scan-column test (4), TypeScript clean, lint 0 errors, `git diff --check`
  clean.

- **CODEX assigned backlog implementation train (Codex, 2026-07-05) — IN PROGRESS.**
  Scope: owner-directed CODEX rows from the backlog exhaustiveness pass: scan column customization,
  approvals triage + alert center, console live-data build-out, `/console/settings` IA pass,
  coach chat -> framework primitives, accessible tooltip primitive, plus annotated parity rows
  for universal ticker drawer, settings affordances/tooltips, model/provider controls, and
  old-vs-new console parity follow-through. Execution plan: split into smaller Codex branches
  with subagent exploration/verification; do not touch AG backend-health lane, Monet risk lanes,
  Claude memory/RAG lanes, or Cursor security/perf rows.

- **PR #853 - sync effort-log mirror with live board (AG, S) — new row, IN PROGRESS 2026-07-05
  (CLAUDE audit-c3).** Branch `ag/effort-log-sync`. `gh pr view 853`: OPEN, mergeStateStatus
  BLOCKED, all CI green, no auto-merge armed, reviewDecision empty. Docs-only board sync; blocked
  only by the ruleset review gate. Open since 07-05 20:38. action=land-it.
- **PR #856 - add CURSOR lane at port 4103, move Monet to 4104 (OWNER, S) — new row, IN PROGRESS
  2026-07-05 (CLAUDE audit-c3).** Branch `cursor/port-4103-agents-md`, authored by owner.
  `gh pr view 856`: OPEN, mergeStateStatus UNSTABLE, mergeable MERGEABLE; the only red check is
  `smoke`=FAILURE (a known recurring flake per repo memory) while verify/gitleaks/classify are
  SUCCESS. Just needs a smoke rerun then merge. action=land-it.


- **Shared-dep tokenless git-dependency switch (CLAUDE, resumed worker) — CLOSED, superseded by #444.**
  _2026-07-05 (CLAUDE next-wave): CORRECTION — `origin/main` already pins
  `@jaywedgeworth22/congress-trading-shared` to `git+https://...#v1.2.0` and
  `scripts/npm-ci-with-shared-deps.sh` is deleted from `main` (landed via the #444 hardening path —
  see the "tokenless public HTTPS `congress-trading-shared` dependency path" Deployed-section rows
  above, PR #444). This row's separately-claimed `claude/tokenless-git-dep` lane (below, under
  Planned/Reserved — worktree `/Users/jay/apps/trading-wt-tokenless-dep`) is therefore also
  superseded; reclaim that worktree and delete `origin/claude/tokenless-git-dep`. Original text
  (retroactive claim 2026-07-04; collision with codex/shared-dep-https-hardening resolved via
  sync-26: Codex hardening reqs folded in — explicit git+https pinned tag + no-SSH npm-ci proof)
  preserved for history._

- **Wave-3 memory/RAG (CLAUDE swimlane, 3-lane team) — IN PROGRESS 2026-07-04 (gated on cars 11-14 reaching main):**
  w3-schema-dissent (frontier tier: belief/iMayBeWrongIf/reversalTriggers/evidenceRefs schema fields
  w/ Bear round-trip, structured Red Team verdict + removed[], non-action case files, debate
  transcript persistence); w3-permodel-loop (mid tier: per-model scoreboard/calibration/deterministic
  assignment + structured-output conformance recording); w3-retrieval-usefulness (mid tier:
  ragAttribution+analog-id joins to matured outcomes, per-source usefulness data, learned-fact
  injection efficacy w/ per-run fact-id stamping).

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
  _2026-07-05 (CLAUDE next-wave): status update — this row predates 2026-07-05's biggest
  machine-side infra changes (the `agent-sync-push` Socket Mode daemon, the tunnel `/post`
  endpoint, and `consumer.mjs`). That work shipped with NO board reservation at all — there was no
  fleet-infra board despite `AGENT-SYNC.md` defining a `fleet-infra` repo tag. Per the fleet-infra
  next-wave spec, a `/Users/jay/apps/FLEET-INFRA-EFFORT-LOG.md` board is being bootstrapped
  (separately, not mirrored into this repo) to backfill that work as rows and give future
  machine-side infra a reservation surface. Current relay state as of 2026-07-05: `agent-sync-push`
  connects to Slack Socket Mode successfully (hello observed in logs) but **zero events are
  delivered** — Slack Event Subscriptions (message.channels) is not yet enabled on the app side
  (owner action pending), so `/Users/jay/apps/agent-sync/events.jsonl` does not exist yet and
  `consumer.mjs`-based reads are currently silent/inert; the legacy 20s `poller.py` Slack-API loop
  remains the working fallback read path until Event Subscriptions is toggled on._

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
  _2026-07-05 (CLAUDE next-wave): CORRECTION — PR #372's mergeable state is **CONFLICTING**; armed
  auto-merge can never fire while it stays conflicting. Stalled since 2026-07-04. Needs a
  merge-forward of `origin/main` (absorbing the ci.yml churn from #370/#799/#812/etc. since #372
  was opened) before it can land — plus the owner still hasn't started the
  `scripts/runner-availability.sh` publisher this design depends on (a separate, non-blocking
  prerequisite for the routing to do anything once merged)._
  _2026-07-05 (CLAUDE audit-c3): re-verified — still OPEN, mergeStateStatus DIRTY, mergeable
  CONFLICTING; auto-merge is armed but cannot fire while conflicting. `git merge-tree` shows real
  conflicts in `ci.yml`/`STATUS.md`/`docs/EFFORT-LOG.md` vs current main. No commits since
  2026-07-04; 8 commits ahead of main. All CI checks green — the block is purely the stale conflict.
  action=reclaim-and-finish; see the new "Rebase/merge-forward PR #372" Planned row below._

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

- 2026-07-04 landing train (Fable operator) — also landed: `claude/console-small-fixes` (**PR #361**), `claude/washsale-advisory-defaults` (**PR #362**), `claude/socratic-expert-review-doc` (**PR #363**), `claude/agent-sync-protocol-docs` (**PR #369**). Wave-2 lanes landed sequentially: `w2-episodic-retrieval` (**PR #437, merged 2026-07-04T21:05:02Z**), `w2-outcome-engine` (merged, see the corrected sub-lane rows above), `w2-coaching-durable`, `w2-reflection-decompose`. _(2026-07-05 CLAUDE next-wave correction: this line said "PR #437 in flight"; #437 has since merged. `w2-coaching-durable`/`w2-reflection-decompose` remain the two genuinely unlanded sub-lanes — no PR opened for either since 07-04.)_

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





- **AGENTS.md fleet-table completion: Cursor 4103 row + Monet 4104 confirmation + stray .codex/ (FLEET, XS) — PLANNED 2026-07-05, awaiting seat responses.** Owner confirmed 2026-07-05: MONET preview = 4104, CURSOR = 4103. The Monet-port line (4103→4104) is committed on `agent/claude` (31d8da7, rides next land). Remaining, each owned by its seat (asked in #agent-sync CLAUDE sync-5): CURSOR documents its 4103 preview row (pm2 process name, hostname, worktree) in AGENTS.md + `scripts/setup-agent-previews.sh` or declares it ad-hoc-only; MONET confirms its lane/tooling expects 4104 (no pm2 `trading-monet` exists yet; nothing listens on 4103/4104); CODEX claims/relocates or approves deletion of untracked `.codex/{setup.sh,maintenance.sh}` left in `~/apps/trading-claude`.

- **CI standard rollout (cross-app, Claude coordinator) — RESERVED, RE-SCOPED 2026-07-04.**
  Deferred until the hybrid resource-aware routing PR above lands and proves itself. Scope when
  picked up: convert the verify gate to a reusable `workflow_call` (hub = this repo,
  **hosted-only by default, zero self-hosted references baked in**; resource-aware routing is a
  separately-approved explicit opt-in input per repo, never inherited silently), flip hub Actions
  access to owner-repos, add caller workflows to congress-trading-shared + API-usage-monitor
  (+ Congress.Trade when bootstrapped), and update canon/global-config bootstrap stanza for
  future repos.

- **Wave-2 memory/RAG core (Claude/Fable coordinator — OWNER-ASSIGNED swimlane) — IN PROGRESS as of 2026-07-04 (moved from Planned; lanes stacked on their w1 dependency branches rather than waiting for the train).**
  _2026-07-05 (CLAUDE next-wave): CORRECTION — `outcome-engine` and `episodic-retrieval` are LANDED
  on `main` (both merged 2026-07-04 per the landing-train row above and this repo's PR history —
  the sub-lane text below still said "Pushed, no PR — lands via the train", which is now stale).
  The two still-pending sub-lanes, `coaching-durable` (branch `claude/w2-coaching-durable`) and
  `reflection-decompose` (branch `claude/w2-reflection-decompose`, stacked on
  `claude/w2-episodic-retrieval`), have sat pushed with **no PR opened** since 07-04 while the
  landing train moved on to the 07-05 lanes (#814/#816/#819/#820/#822). Explicit landing action
  needed: merge-forward each branch onto current `origin/main`, run the full gate, open a PR with
  auto-merge for each — see the new "Open PRs for the stalled w2-coaching-durable and
  w2-reflection-decompose branches" Planned row below._ Lanes:
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
    tsc clean / 2383 tests / 246 files / build). **LANDED on `main`** (2026-07-05 CLAUDE next-wave
    correction: this line previously said "Pushed, no PR — lands via the train after
    w1-learning-loops", which is now stale — merged via the 2026-07-04 landing train). See
    docs/rollouts/2026-07-04-w2-outcome-engine.md.
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
    **LANDED on `main`** (2026-07-05 CLAUDE next-wave correction: this line previously said
    "Pushed, no PR — lands via the train after the w1-rag-quickwins base lands", which is now
    stale — merged via the 2026-07-04 landing train). See
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
  _2026-07-04 assignment: CODEX._
- Settings affordance and tooltip pass - add clearer option descriptions/tooltips,
  replace confusing loose/tight wording with lock/unlock-style affordances, and
  turn absolute-vs-percent constraint pairs into polished mode switches where
  they represent alternative ways to express one setting.
  _2026-07-04 assignment: CODEX._
- Model/provider control parity - move strategy model controls toward curated
  dropdowns with provider-aware settings, showing reasoning controls only for
  models that actually support them.
  _2026-07-04 assignment: CODEX._
- Admin connection health and backend-failure notification pass - surface every
  backend dependency including Pinecone/Voyage, distinguish global backend failures
  from user-key failures, and route global failures to admin email/health while
  user-key failures become user notifications.
  _2026-07-04 assignment: AG (Antigravity), incl. per-provider failure-injection test._
- Old-vs-new console parity audit follow-through - review the legacy dashboard for
  features still missing or less discoverable in `/console`, including scan column
  customization, admin/operator navigation, account display preferences, and
  connection status.
  _2026-07-04 assignment: CODEX._

### 2026-07-04 backlog exhaustiveness pass — promoted items with assigned lanes
_Owner-directed. Full row detail (sources, descriptions) lives in the repo mirror
`docs/EFFORT-LOG.md`, which drives the GitHub Issues mirror; this live-board copy is the
reservation of record. Tags: CURSOR = Cursor background agents (DeepSeek v4 Pro), CODEX = Codex,
AG = Antigravity/Gemini, MONET = Claude Monet (Opus, risk lane), CLAUDE = Claude Code (memory/RAG)._

- CURSOR (17 rows, S/M) — **COMPLETED 2026-07-05 (PR #808).** 9 confirmed already-done +
  7 implemented (security headers, unpriced-model default cost, synthetic bid/ask boolean
  provenance, scheduler health threshold, operator monthly LLM spend ceiling, effort-mirror
  orphan report, Litestream PITR retention) + 1 blocked by Codex keepout (global symbol omnibox).
  Full P0+P1 rollout: `docs/rollouts/2026-07-05-cursor-session.md`.
- CODEX (6 rows + 5 annotated parity rows above): scan column customization; approvals triage +
  alert center; console live-data build-out (SSE/mark-to-market/blotter/intraday charts);
  /console/settings IA pass; coach chat->framework primitives; accessible tooltip primitive.
- AG (7 rows + 2 annotated): fill-history fetch dedupe; congress-score-eval wiring; Robinhood
  option-chain IV enrichment; E2E money-path test; concurrency/fault-injection suite;
  horizon-matched IC; congress push/SSE contract repair (cross-app).
- MONET (6 rows, risk lane): Red-Team fail-open->policy-aware routing; vol-targeting sizing +
  portfolio heat; correlation gate + event blackouts + stress scenario; fractional Kelly;
  multi-signal regime scorer; regime-enum adoption in risk gates.
  _2026-07-05 (CLAUDE): regime-enum row shipped earlier as PR #449; the 5 remaining rows claimed
  (cross-seat pickup, owner-confirmed CLAUDE session) → see the risk-lane implementation train
  row under In Progress._
- CLAUDE (6 rows): usage-budget Phase-2 wiring; RAG eval harness; prompt eval/versioning; HyDE +
  multi-query retrieval; durable due-jobs substrate; per-user token-budget ceiling.
- Unassigned owner-decision bucket (15 rows): strategy.ts split; repository/write-queue layer;
  factor-weight auto-apply; deflated-Sharpe/PBO gates; CPCV backtests; joint portfolio
  construction; active hedging; transcript/news PIT ingestion; groundedness gate; leakage
  certificate; tamper-evident audit chain; model/prompt registry; decision-bundle replay;
  multi-user fill streaming; admin subdomain.

### 2026-07-05 full itemization (owner-directed follow-up)
_Owner flagged the pass above as still non-exhaustive. Three enumeration agents classified EVERY
finding in the expert design review (147), the composite review, the full 2026-06-30 improvement
audit, the 2026-07-01 learning-loop/RAG expansion backlogs, and June residual docs. ~220 further
untracked findings are now INDIVIDUAL Planned rows in the repo mirror `docs/EFFORT-LOG.md`
("2026-07-05 full itemization" + "Deep-sweep additions" subsections — the mirror is the row-level
source of truth feeding the GitHub Issues mirror; this live-board entry is the reservation).
Approximate lane split: CLAUDE ~55 (RAG/memory/prompting), AG ~60 (data providers, learning-loop
statistics incl. the auto-apply safety prerequisites, testing), MONET ~40 (risk/decision-making +
security-hardening receipts), CODEX ~40 (console/UI), CURSOR ~45 (mechanical fixes, ops
verifications, observability), unassigned ~15 (owner decisions incl. tuning cadence, multi-symbol
fact schema, /old maintenance policy, doctrine store). Includes two live bugs: partial-day ADV in
the impact model (AG) and checkRegimeFlip's non-atomic 'local'-hardcoded RMW (CURSOR)._

### 2026-07-05 next-wave (cycle 2)
_Added 2026-07-05 (CLAUDE next-wave). Sourced from a fresh cross-agent audit of the board against
live PR/git state; see the stale-row corrections applied above in this same pass for the
discrepancies that motivated these rows._

- ~~**Disentangle PR #805: land Cursor P0/P1 commit and AG health slice as separate merges (CURSOR, S)** —
  Resolve #805's conflicts, split commit 0ce39474 (per-user regime keys, security headers, spend
  ceiling) from the AG connection-health work, land both with honest PR records. _(why now: The
  board's phantom 'PR #808 merged' hides that the P0 multi-user regime RMW race and the security
  headers are still NOT on main; the only vehicle is a CONFLICTING two-lane PR.)_~~
  _2026-07-05 (CLAUDE audit-c3): MOOT — retired. PR #844 (`claude/pr805-remediation`, squash
  `ebcf6a23`) merged 2026-07-05 and already contains BOTH the Cursor P0/P1 commit (per-user
  `regime:current:${userId}` keys, security response headers, LLM_SPEND_CEILING) AND the AG
  connection-health slice, landed as one honest PR rather than a split — exactly the option this
  row itself named as acceptable. #805 is CLOSED (superseded). No further action; row kept per
  never-delete-a-row rule. action=mark-blocked (on the now-closed #805 itself)._
- ~~**Migrate legacy regime:current row to per-user keys at first tick after the P0 fix lands (CURSOR, S)** —
  Seed regime:current:${userId} from the old shared row (or tolerate absence) so the first
  post-deploy tick doesn't fire false regime-flip notifications or lose escalation state. _(why now:
  The checkRegimeFlip fix changes the settings key shape; without a migration every user's stored
  regime resets on upgrade — a correctness gap the fix itself introduces.)_~~
  _2026-07-05 (CLAUDE audit-c3): MOOT — retired. `#844` (squash `ebcf6a23`) already includes the
  legacy `regime:current` → per-user `regime:current:${userId}` migration alongside the P0 fix in
  `src/lib/regime-watch.ts`; this is on `main` today, not a follow-up. No further action needed.
  action=mark-blocked (nothing left to migrate)._
- **Owner ratification: Rule 4 fundamentals-veto overridability shipped in #814 (OWNER, S)** —
  Decide whether the deliberately model-independent FCF/debt-equity veto should stay
  agent-overridable or be re-hardened; the code flags this decision in-line. _(why now: #814 merged
  with an explicit owner-ratification flag on Rule 4; leaving it unratified means a design decision
  on the money path is implicitly made by default.)_
- **Production release + post-deploy money-path verification of the 2026-07-05 batch (OWNER, M)** —
  Run the ~/apps/trading-live release for the ~12 merged PRs, then verify on a real run: override
  path behavior, new audit kinds emitted, alert center + live-data console slices working. _(why
  now: Three money-path behavior changes (#799/#814/#816) plus major console work are beta-only;
  nothing merged 07-05 has been verified in production, and the Deployed board section stops at
  07-04.)_
- **Render the new advisory audit kinds in the console alert center and activity feed (CODEX, S)** —
  Label/filter deterministic_bear_veto, red_team_veto_overridden, prompt_injection_suspected, and
  evidence_age_anomaly events; zero app/ references to these kinds exist today. _(why now: #814/#816's
  whole design is 'detection IS the control' — advisory receipts are worthless if the owner-facing
  surfaces don't surface them; #807's alert center is the natural home and just merged.)_
- **Wire the getRedTeamEfficacy scorecard into the console (CODEX, M)** — Surface the veto-efficacy
  metrics (API/db-level since the w1-learning-loops landing) on the console, including
  override-vs-non-override splits now that #814 protects the metric. _(why now: The w1 row
  explicitly deferred UI wiring to the console lane and it was never tracked as its own row; #814's
  FIX #1 (no counterfactual on override path) makes the metric trustworthy now.)_
- **Headline first-seen timestamps to close the evidence-age receipt gap (CLAUDE, M)** — Persist
  first-seen times for news headlines so the #816 evidence-age anomaly receipts can cover them
  (currently explicitly deferred because headlines carry no timestamp). _(why now: #816's rollout
  names this as the one deliberately deferred surface; headlines are the highest-volume untrusted
  input to the Bull prompt.)_
- **Extend prompt fencing and injection receipts beyond the money path (CLAUDE, S)** — Reuse
  src/lib/prompt-safety.ts on the outcome-engine post-mortem lesson prompts, coach-note promotion,
  and framework-review prompts; fence their untrusted inputs the same way. _(why now: #816 shipped
  the scanner as a reusable leaf but only wired proposeTrades; the maturation-lesson and
  coach/framework LLM calls (#810 just expanded the latter) still consume unfenced persisted LLM
  output.)_
- **Open PRs for the stalled w2-coaching-durable and w2-reflection-decompose branches (CLAUDE, S)** —
  Merge-forward both pushed branches onto current main, run the gate, open PRs with auto-merge; they
  have sat PR-less since 07-04 while their sibling lanes landed. _(why now: Durable coaching and
  decomposed reflection lessons are finished, verified work rotting on origin; every day unlanded
  increases merge-conflict cost against the fast-moving strategy.ts/learning files.)_
  _2026-07-05 (CLAUDE audit-c3): re-verified both, still true and still unlanded — reassigned
  CLAUDE->CLAUDE (no change of lane, reclaiming as still-open work):
  `claude/w2-coaching-durable`: `git ls-remote` shows the branch exists on origin, 2 commits ahead
  of main, last commit 2026-07-04 12:21; `gh pr list --state all` shows NO PR ever opened for this
  headRef. Finished/verified per rollout doc but not landed. action=open-PR.
  `claude/w2-reflection-decompose`: branch on origin, 3 commits ahead of main, last commit
  2026-07-04 12:38; NO PR in `gh pr list --state all`. Stacked base (`w2-episodic-retrieval`) already
  merged via #437, so it can now be merge-forwarded onto main standalone. Rotting since 07-04.
  action=open-PR._
- **Batch typed-confirm flow for LIVE proposals in approvals triage (CODEX, M)** — Extend #807's
  bulk actions to LIVE proposals with a single aggregate typed confirmation (per-item provenance
  preserved), instead of forcing one-by-one confirms. _(why now: #807's rollout explicitly scoped
  bulk LIVE out; with the owner running real money and multiple proposals per run, one-by-one typed
  confirms are the exact ceremony the product philosophy says to minimize.)_
- **Sweep settings-table keys for remaining cross-user shared-row races (CURSOR, S)** — Audit every
  hardcoded settings key (scheduler leader, system state, caches) for the same shared-row RMW
  pattern checkRegimeFlip had; per-user-scope or single-writer-guard each hit. _(why now: The P0
  regime race was found by inspection, not by a systematic pass; multi-user correctness is a stated
  priority and the same pattern likely exists on other keys.)_
- **MONET risk-row handback (MONET)** — the five risk rows picked up cross-seat by CLAUDE on
  2026-07-05 (changepoint throttle, correlation/blackout/stress, fractional Kelly, regime scorer,
  vol-targeting) return to MONET; the five empty .claude/worktrees/monet-* worktrees are
  reclaimable.

### 2026-07-05 audit cycle-3
_Added by CLAUDE audit-c3 pass. Tags: CURSOR / CODEX / AG / MONET / CLAUDE / OWNER. Assignments are
reservations, not locks — re-negotiate in #agent-sync. NEVER assign to CODEX (quota-capped to
Jul 8 18:10 CT)._

- **Retire stale cycle-2 board rows falsified by PR #844 merging (P0 regime race + security headers ARE on main) (CLAUDE, S)** — The live board's '2026-07-05 next-wave (cycle 2)' corrections still assert the P0 multi-user regime RMW race and security headers are NOT on main and that CONFLICTING #805 is 'the only vehicle'. Origin-verified false: #844 squash ebcf6a23 landed regime:current:${userId} per-user keys + legacy migration (src/lib/regime-watch.ts), HSTS/X-Content-Type-Options/Permissions-Policy (middleware.ts + test/security-headers.test.ts), LLM_SPEND_CEILING, and the effort-orphan report. Mark the 'Disentangle PR #805', 'Migrate legacy regime:current row', and '#805 In-Progress/blocked' rows Completed-via-#844 and close #805 references. Board is over-reporting in both directions; this is the biggest source of confusion. STATUS: applied this pass — see the PR #844 Completed-section row and the strikethrough corrections on the two cycle-2 Planned rows.
- **Resolve main-protection ruleset review gate that leaves all-green PRs stuck BLOCKED (OWNER, S)** — Three PRs (#818, #853, #854) have every CI check green yet sit mergeStateStatus=BLOCKED with reviewDecision empty — the main-protection ruleset requires review approval and/or conversation-resolution that no agent can self-satisfy. This is a structural throughput bottleneck: agents open ready PRs that can never auto-land. Decide/document the unblock path (owner approval lane, or a bot-approval exemption for docs-only PRs) so green PRs stop stranding.
- **Rebase/merge-forward PR #372 onto current main to clear the ci.yml conflict (CLAUDE, M)** — PR #372 (CI hybrid-runner) has been CONFLICTING with auto-merge armed since 07-04; the armed auto-merge can structurally never fire. git merge-tree shows conflicts in ci.yml plus STATUS.md/docs/EFFORT-LOG.md from the ~10 CI-touching PRs merged since. Needs a merge-forward of origin/main + conflict resolution, then it can land. Separately, its runner-availability.sh publisher prerequisite is still owner-pending but does not block the merge.
- **Prune stale abandoned local-only branches from origin (June 21–29 experiments) (OWNER, M)** — ~40 origin branches are ahead of main with NO PR and last activity June 21–29 (agent/claude-*, safety/*, feat/*, reliability/*, sim/funded-test-account, etc.). They are stale experiments from the pre-worktree era, add noise to every branch scan, and confuse abandoned-work triage. Audit which are fully superseded by merged work and delete them from origin (with owner confirmation before any deletion per the no-destructive-git rule).

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
- 2026-07-04 - CLAUDE: backlog exhaustiveness + assignment pass (owner-directed). Added the
  promoted-backlog Planned section with per-agent lanes (CURSOR/CODEX/AG/MONET/CLAUDE +
  unassigned bucket) and annotated pre-existing Planned rows with assignments. Repo mirror
  carries full row detail and feeds the GitHub Issues mirror.
- 2026-07-05 - CLAUDE: full itemization pass (owner-directed follow-up): ~220 additional
  individually-tracked Planned rows covering every remaining review-doc finding; see the repo
  mirror for row detail.
- 2026-07-05 (CLAUDE next-wave) - Applied the next-wave cycle-2 stale-row correction pass from
  both the socratic-trade and fleet-infra next-wave specs: moved the phantom "PR #808 merged" row
  back to In Progress (real vehicle is unmerged commit 0ce39474 inside CONFLICTING PR #805 — the
  P0 multi-user regime race is still live on main); moved PR #811 (console live-data), the
  pre-policy-vetoes/#814, full-suite-determinism/#812, and guardrails-denylist/#799 rows to
  Completed (all were already merged but mis-filed under In Progress); re-marked the AG
  connection-health row (PR #805) as In Progress/blocked-on-conflict instead of Completed; closed
  the tokenless-git-dep row as superseded by #444; annotated PR #372 as CONFLICTING/stalled;
  marked w2-outcome-engine and w2-episodic-retrieval as landed and flagged w2-coaching-durable /
  w2-reflection-decompose as still needing PRs. Added the "2026-07-05 next-wave (cycle 2)" Planned
  subsection (11 new rows) plus a MONET risk-row handback note.
- 2026-07-05 (CLAUDE next-wave) - CORRECTION: no live-board row previously tracked **PR #801**
  ("fourteen logo concept comps" open PR, branch `claude/socratic-trade-logos-p0hxk7`), so noting
  it here rather than editing a nonexistent row. #801 is superseded: **PR #809** ("12 logo concepts
  for Socratic.Trade") merged 2026-07-05T08:52:13Z and the owner made a final selection (Dialectic
  mark + named lockup) the same day (see commit `a9cefbf4` "docs(branding): final selection —
  Dialectic mark + named lockup saved"). #801 should be closed as superseded by #809/the final
  selection and its branch archived.
- 2026-07-05 (CLAUDE audit-c3) - Audit cycle-3 pass: CRITICAL correction — confirmed PR #844
  (squash `ebcf6a23`) merged and contains the P0 per-user regime-race fix + security headers +
  LLM_SPEND_CEILING, falsifying the cycle-2 rows that said these were still missing; moved the
  "PR #808" and AG connection-health rows to Completed under a consolidated "PR #844" entry, and
  retired (struck through, annotated moot) the "Disentangle PR #805" and "Migrate legacy
  regime:current row" cycle-2 Planned rows. Moved PR #854 (webhook HMAC/idempotency) from
  Completed back to In Progress — confirmed OPEN/BLOCKED (ruleset gate), not merged. Re-verified
  and re-dated PR #372 (still CONFLICTING) and PR #818 (still BLOCKED-on-ruleset). Added two new
  In Progress rows for previously untracked open PRs #853 (effort-log mirror sync, AG) and #856
  (port-lane docs, owner) with current gh state. Reassigned CODEX -> AG on the stranded
  `codex/console-tooltip-primitive` (never pushed to origin, Codex quota-capped to Jul 8).
  Reclaimed/reconfirmed the still-PR-less `claude/w2-coaching-durable` and
  `claude/w2-reflection-decompose` branches (open-PR action). Added 4 new Planned rows under
  "2026-07-05 audit cycle-3": retiring the falsified cycle-2 rows, resolving the main-protection
  ruleset bottleneck (OWNER), rebasing PR #372, and pruning ~40 stale June 21-29 branches (OWNER).

- 2026-07-05 — **UI audit + design-system unification review (CLAUDE, docs/design only; no code landed).** 7-lens expert panel (adversarially verified) over the live UI + decode of the claude.ai/design "Socratic Trade UI Kit". Key facts: app runs TWO disjoint design systems (ui glass-token `app/ui` vs console `con-*` `app/console`); the UI Kit is a faithful hash-tied EXPORT of both (30 leaf primitives, no composites), NOT a redesign. 55 verified findings (1 P0: money-reality LIVE/PAPER banner hardcoded dark-only Tailwind → wrong in default light theme, `app/dashboard-client.tsx:443`). Direction: "two renderers, one brand core" — unify token values + tone vocab (`pos/neg`), keep both render methodologies, defer the L-effort primitive merge; grow the Kit with `con-table` + modal/sheet family first. Deliverables: `docs/reviews/2026-07-05-ui-audit-and-design-system-unification.md` + interactive artifact `https://claude.ai/code/artifact/792a356c-79df-4bb1-b413-5979dd67a909`. State: **Completed (analysis/plan deliverable)**; implementation **Planned** — owner to sequence (Phase 0 P0 first). Not deployed (no code).
