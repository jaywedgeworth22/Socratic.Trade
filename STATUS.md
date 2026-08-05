**2026-08-04 — GROK: retire direct FMP / QuiverQuant / Unusual Whales.** Owner:
Socratic.Trade must not call those vendors. Congressional disclosures/analytics from
Congress.Trade (default ON); **fundamentals from multi-source cascade** (Yahoo/Finnhub/
ROIC/SEC/… — App A fundamentals default OFF). Hard ban at registration + request choke
points. Branch `grok/no-direct-fmp-quiver-uw` (PR #2398).
Rollout: `docs/rollouts/2026-08-04-retire-direct-fmp-quiver-uw.md`.

**2026-08-04 — Final Verification of Model Slugs (AG).** Branch `agent/antigravity/openrouter-classifiers`. Replaced all legacy `-latest` model slugs with Provider Native Slugs (`gpt-5.6-sol`, `gpt-4o`, etc.) across the codebase. Cleaned up duplicate properties in model configuration files. Fixed test regressions in history tests by adding DB isolation to `historyTestDb` shared per-file. Fixed `isGpt56Model` regex. Gates verified: tsc clean, lint clean, full test suite passes. Landed cleanly via `land.sh`.
Rollout: `docs/rollouts/2026-08-04-model-slug-test-fixes.md`.


# STATUS — current repo snapshot

**2026-08-04 — GROK: Congress filing-date member skill → ST.** Prefer CT `filingDate`
copy-trade skill (shared package v2.5.0 dual performance); restore `memberSkill` weight
0.2; persist raw avgExcess/winRate/scoredCount on quotes + signal_snapshot. Branch
`grok/congress-filing-skill`. Rollout:
`docs/rollouts/2026-08-04-congress-filing-member-skill.md`.

**2026-08-04 — GROK: retire direct FMP/Quiver/UW; fundamentals multi-source.** Hard ban
on direct FMP/Quiver/UW. Congress.Trade for disclosures/analytics (default ON);
fundamentals from the multi-provider cascade (App A fundamentals default OFF). PR #2398.
Rollout: `docs/rollouts/2026-08-04-retire-direct-fmp-quiver-uw.md`.
**2026-08-04 — Full-Bleed Pure White App Icon Assets (ANTIGRAVITY, branch `agent/antigravity`).** Updated `public/icon.svg` canvas to 100% full-bleed white background (`#ffffff` without transparent corners), updated `app/manifest.ts` PWA `background_color`/`theme_color` to `#ffffff`, and regenerated all PNG icons (`apple-touch-icon-180.png`, `icon-192.png`, `icon-512.png`, and iOS Xcode `AppIcon-1024.png`). Verified `tsc` clean and asset rendering. Rollout: `docs/rollouts/2026-08-04-full-bleed-white-app-icon.md`.

**2026-08-04 — GROK: PR drain complete; prod deploy unblocked via slim Dockerfile.** Merged open PRs #2367-#2371, #2375, #2381. Prod stuck on 6ad913d5 because Coolify timed out on multi-GB `COPY --chown`. Fix: `.dockerignore` + prune + chown-in-RUN (`grok/docker-slim-deploy`). Rollout: `docs/rollouts/2026-08-04-docker-slim-deploy.md`.

**2026-08-04 — GROK: paper-account learning parity (Learning Review).** Owner: paper
trades are first-class for model/task comparison unless a definite paper-exclusive
cause applies. Prompt rule + portfolio-scoped decision lessons + environment on review
items. Branch `grok/paper-learning-parity`. Rollout:
`docs/rollouts/2026-08-04-paper-learning-parity.md`.

**2026-08-04 — GROK: deploy 178 failed (missing better-sqlite3 .node); fixing native rebuild.**
PRs drained; slim image builds (1.45GB) but healthcheck 500: `better_sqlite3.node` missing after
`npm rebuild` no-op post-prune. Branch `grok/docker-sqlite-native`: prune --ignore-scripts,
global node-gyp, clean rebuild, assert load. Prod still on 6ad913d5 (healthy). Rollout:
`docs/rollouts/2026-08-04-docker-sqlite-native.md`.

2026-08-01 were moved to `docs/status-archive.md`.

Last updated: 2026-08-04 (GROK: UX improvement program plan).


## UX improvement program (2026-08-04, GROK)

Sequenced PR plan for web console + PWA + iOS after a full-product review:
`docs/design/ux-improvement-program.md`. Wave A (trust/action) slices are Planned/UNASSIGNED
on the effort board — claim before implementing. Rollout:
`docs/rollouts/2026-08-04-ux-improvement-program.md`.

## Where things stand

**2026-08-04 — Multi-Source Quote Cascade & Staleness Resolution (ANTIGRAVITY).** Implemented a 5-level redundant quote cascade resolving active broker gateway → Alpaca snapshots → Yahoo batch → Yahoo single → ROIC.ai profile. Converted the quote staleness policy check into a non-blocking gate that mutates opening orders to limit orders to defend the price (buy capped at min(limit, ref), short capped at max(limit, ref)), appends warning text to rationale, writes a `quote_staleness_warn` audit trail, and alerts the user via `provider_degraded` push. Full tests and builds check out clean. Rollouts: `docs/rollouts/2026-08-04-multi-source-quote-cascade.md`, `docs/rollouts/2026-08-04-non-blocking-quote-staleness-gate.md`.
**2026-08-04 — Multi-Source Quote Cascade & Staleness Resolution (ANTIGRAVITY).** Added a redundant multi-source quote cascade in `src/lib/quotes-cascade.ts` checking broker quotes, Alpaca snapshots, Yahoo batch, and Yahoo single quote APIs in series. Integrated it across the strategy run loop, proposal approvals, and chat draft promotion. Added a unit test suite to verify the cascade level routing. Full type check and lints pass. Rollout: `docs/rollouts/2026-08-04-multi-source-quote-cascade.md`.

**2026-08-04 — EOD Quote History Cache SQLite Migration (ANTIGRAVITY).** Migrated the legacy flat-file JSON EOD quote caching (`data/history-5y/`, etc.) in `src/lib/history.ts` to a fully SQLite-backed table `history_cache_eod` to resolve test failures and ensure robust silent-caching. Replaced `fetchLocalFlatFileHistory` with `fetchHistoryCacheEod`. Updated the `test/history.test.ts` suite to seed the SQLite DB directly. Full tests pass. Rollout: `docs/rollouts/2026-08-04-history-cache-eod-migration.md`.

**2026-08-03 — Subdomain Host Routing & EOD Quote Caching Upgrade (ANTIGRAVITY, branch `agent/antigravity`).** Added `mobile.socratictrade.com` $\rightarrow$ `/mobile` and `console.socratictrade.com` $\rightarrow$ `/console` host-level routing in `middleware.ts`. Upgraded EOD price history in `src/lib/history.ts`: added `isBarSeriesFresh` staleness detection, `mergeOHLCBars` merging for stale flat files, auto-persistence of fresh provider bars into SQLite `imported_price_eod` and disk, and `eod_cache_stale` audit logging. All gates green (`tsc`, `lint`, vitest 27/27, Next.js `build`). Rollout: `docs/rollouts/2026-08-03-eod-quote-caching-and-subdomain-routing.md`.

**2026-08-03 — iOS/mobile account switch hangs (MONET, branch `monet/ios-account-switch-fix`).**
Owner screenshots: Roth IRA spinner stuck, Sandbox still Active, Home stale + 2 queued · 1
running. Root cause: `account.activate` waited on the global sequential mobile worker behind
`strategy.run_once`, and clients also blocked switch when the snapshot was stale. Fix: run
`account.activate` immediately (same path as stop), allow switch on stale snapshot (iOS + PWA),
clear iOS busy spinner from the terminal POST before snapshot reload. Focused mobile tests
16/16; full gates via land.sh. Rollout:
`docs/rollouts/2026-08-03-ios-account-switch-immediate.md`.
**2026-08-03 — Console RAG Evidence Card Deduplication (ANTIGRAVITY, branch `agent/antigravity/mobile-pwa-feedback`).** Fixed duplicate RAG evidence rendering (`sec-edgar` and `Retrieved 10 K` cards showing identical document receipt & score) in proposal drawer by deduplicating RAG attributions against `decision.evidence` in `deriveEvidenceRows` (`app/console/page.tsx`). Rollout: `docs/rollouts/2026-08-03-dedupe-evidence-cards.md`.

**2026-08-03 — Console dashboard `topCandidates.slice` white-screen (GROK, branch
`agent/grok-fix-dashboard-topcandidates`).** Owner report: main `/console` showed
`Dashboard error` / `undefined is not an object (evaluating 'r.topCandidates.slice')`.
Root cause: `deriveEvidenceRows` assumed every truthy `latestScan` had array
`topCandidates`. Fix: `safeTopCandidates` + snapshot normalization in `dashboard.ts`.
Rollout: `docs/rollouts/2026-08-03-console-topcandidates-slice-crash.md`.

**2026-08-03 — Xcode App Settings & Apple Sign-In Layout Constraint Fix (ANTIGRAVITY).** Configured Xcode App Category (`public.app-category.finance`), Display Name (`Socratic.Trade`), Marketing Version (`1.0.0`), and Build Version (`1`) across `Info.plist` and `project.pbxproj`. Fixed `ASAuthorizationAppleIDButton` layout constraint collision warning (`width == 392` vs `width <= 375`) in `LoginView.swift` by capping `SignInWithAppleButton` width to 375pt. `xcodebuild` succeeded clean. Rollout: `docs/rollouts/2026-08-03-xcode-app-settings-and-apple-signin-constraint-fix.md`.

**2026-08-02 — Exit-0 outage root-caused + exit-code hardening (MONET, branch
`monet/exit0-outage-audit`).** The 15:29Z "clean exit 0, stayed down" outage was an
**unpaired docker-API stop**, with the 0 fabricated by a pid-1 signal-re-raise bug in the
infisical wrappers plus in-container npm swallowing SIGTERM (sandbox-reproduced in the
real image; every deploy had been hard-killing next-server). Fixed: wrappers exit 128+N,
boot script now supervises the app (spontaneous clean exit → 40, every exit logged,
`node_modules/.bin/next start` direct — npm banned from the exec chain), new
production-gated `src/lib/exit-guard.ts` re-tags spontaneous in-app exit(0) → 43 with
call-site receipts. Restart policy is already `unless-stopped` — evaluated, **no flip**
(it restarts any spontaneous exit; the outage class is API stops, now covered by rule +
honest codes). `docker events` forensics verified broken (~256-event ring ≈ minutes on
this box) — journalctl is the durable source. Contract + traps codified in AGENTS.md
("Production exit-code contract"). Rollout:
`docs/rollouts/2026-08-02-exit0-outage-audit.md`. Next prod stop/deploy should log
`app exited with code 143 after forwarded SIGTERM` as live confirmation.

**2026-08-02 — 5-Year Local Flat-File Price History Priority (ANTIGRAVITY).** Added `fetchLocalFlatFileHistory(symbol)` as the #1 primary tier in `src/lib/history.ts` (`fetchDailyOHLC`) and `fetchGroupedBarsLocal(date)` in `src/lib/market-signals/massive.ts`. Any pre-hoarded 5-year Massive flat files (`data/history-5y/`, `data/massive-history/`) are read directly from disk without hitting external REST APIs, providing instant zero-cost history for backtests and Congress.Trade EOD price feeds (`/api/market/prices/[symbol]`, `/api/market/spx`). Rollout: `docs/rollouts/2026-08-02-local-flatfile-history-priority.md`.

**2026-08-02 — Mobile PWA owner-feedback round (Monet, cloud session).** Branch
`agent/antigravity/mobile-pwa-feedback` (applying patch from Monet): PWA gets
an Accounts section (switch broker account via `account.activate`, sign-out link to switch Google/Apple
login), per-proposal realtime approve/reject feedback (tapped button spins; card follows its queued
command through queued/running/succeeded/failed instead of failures hiding in the Command Log), and the
delete-account panel is collapsed behind a neutral link so it stops mimicking error banners. tsc clean,
mobile test file 10/10, lint 0 errors. Landed as #2351 (`44069368`).
Rollout: `docs/rollouts/2026-08-02-mobile-pwa-owner-feedback.md`.

**2026-08-02 — Data-provider hardening, Round 1 (MONET, `monet/data-cascade-freshness`,
merged as #2353).** Implemented the free-tier research doc's own recommendations: Tiingo
now ALSO an OHLC-history source in `history.ts` (was enrichment-only — a configured key
delivered none of the promised adjusted-history value until this landed), dead Stooq tier
removed (confirmed PoW-bot-walled), keyless Treasury.gov yield-curve fallback (3M/2Y/10Y +
curves, no FRED key needed), Cboe VIX9D, SEC-XBRL `revenueGrowth`. Full gates green.
Rollout: `docs/rollouts/2026-08-02-data-provider-hardening.md`.

**2026-08-02 — Data-provider hardening, Round 2/3 (MONET, `monet/data-cascade-providers-round2`).**
Closes out the rest of the same research doc: 3 new key-gated fundamentals/news providers
(Wisesheets, SimFin, Marketaux — all dormant until their env key is set), 2 new keyless
sources (BLS macro fallback wired into the Macro board, Nasdaq earnings-calendar backfill),
an S&P 500 constituents mirror (built, not yet wired to replace the static universe list —
see the rollout note), Yahoo 429 hardening, and Alpha Vantage/Finnhub earnings-calendar
fallbacks. USAspending.gov investigated and correctly NOT implemented (no free
recipient→ticker crosswalk exists). Full gates green: lint 0 errors, tsc clean, 5891/5891
tests, build clean. Rollout: `docs/rollouts/2026-08-02-data-provider-round2.md`.

| | |
|---|---|
| `main` | `44069368` — Codex remediation (#2341), npm `allowScripts` fixes (#2345, #2349), mobile PWA feedback round (#2351) |
| In flight (MONET) | `monet/exit0-outage-audit` — exit-0 outage RCA + exit-code hardening (PR pending). `monet/broker-mutation-mutex-pr2` LANDED as #2361 (§7 slice 3 COMPLETE; corrected in place — was listed in flight); its deploy is also the freshness-lane re-enable live test. Landed today: #2350, #2352, #2354, #2360, #2361. Rollout: `docs/rollouts/2026-08-02-account-mutation-lease-pr2.md` |
| Production (`socratictrade.com`) | `c117afb9` verified live ~05:35Z — SECOND organic cutover since the repair; `b7d88e42` builds next (serialized) |
| Deploy mechanism | auto-deploy on push to `main` — **repaired 2026-08-02** (webhook HMAC secret was mismatched; see blocker 1) |
| Core trading health | DB ok, scheduler ticking, 3 active accounts / 0 degraded, litestream replicating |
| Data providers | `dataProvidersDegraded=true` — FMP plan probe 403, Massive capped to ~2y history (unchanged, owner decision pending) |

## Blockers

1. **RESOLVED 2026-08-02 — auto-deploy was broken by a webhook HMAC mismatch.** Every push
   to `refs/heads/main` was answered by Coolify with
   `[{"status":"failed","message":"Invalid signature."}]` (visible only in the GitHub hook
   delivery RESPONSE BODY — the hook page showed green 200s throughout), so no deployment
   was ever created; the queue sat empty and the single 2026-08-01 deploy was the owner's
   manual click. Repair: synced the GitHub hook secret to the Coolify app's
   `manual_webhook_secret_github`, deleted the exact-duplicate second hook, redelivered the
   newest main push -> a real deployment was created immediately, and
   `scripts/verify-deploy-sha.sh 19dfd51b` reported **PASS** (~04:47Z). Merge==live is
   trustworthy again. Also fixed: AGENTS.md's stale Coolify uuid (the app is `socratic-app`
   now). Full receipts + recurrence warning:
   `docs/rollouts/2026-08-02-deploy-webhook-secret-repair.md`.

2. **RESOLVED — npm `EALLOWSCRIPTS` on the shared git dep (and the earlier explanation
   here was wrong).** A clean-shell reproduction with the repo's exact files PASSES: the
   repo as committed installs fine, and a stale `allowScripts` tag was NOT the trigger.
   The real triggers (npm 11.16.0+, upstream bug npm/cli#9783, open, unfixed through npm
   12.0.2): an `allow-scripts=...` line in ANY `.npmrc` layer, or an inherited
   `npm_config_allow_scripts` env var — npm forwards it into its git-dep preparation
   subprocess, which rejects it as a flag. This Mac had live `npx`-launched processes
   exporting `npm_config_allow_scripts=@wasp.sh/wasp-cli`; any shell descending from that
   lineage fails every `npm ci` instantly. If EALLOWSCRIPTS appears: check
   `env | grep npm_config_allow_scripts` and relaunch the contaminated parent — and NEVER
   add `allow-scripts` to `.npmrc`, even though npm's own error message suggests it.
   Also fixed forward: `allowScripts` git-dep keys in tag form (`#vX.Y.Z`) can never match
   (npm compares against the resolved 40-char SHA), which npm 12 escalates from a warning
   to a hard block on the dep's `prepare` — the key is now committish-free
   (`"github:jaywedgeworth22/congress-trading-shared": true`, verified: coverage warning
   gone). #2345's lockfile regen also fixed a real silent bug: the old lockfile pinned the
   v2.3.0 commit while package.json said v2.4.x, so `npm ci` was silently shipping the old
   shared package. Verified 2026-08-02: plain `npm ci` = exit 0, 575 packages, clean shell.
   (An earlier copy of this blocker blamed a stale `allowScripts` tag — corrected above;
   the union merge briefly duplicated both versions here, de-spliced 2026-08-02.)

3. **Two provider lanes are degraded and need an owner decision, not an agent fix.**
   FMP's plan probe returns 403 (subscription state) and Massive is history-capped to the
   free tier. Agents must not provision replacement keys. Several optional/telemetry lanes
   (Usage Monitor, VIX-Yahoo, Nasdaq Quote, some RapidAPI lanes) are also down; those are
   fallback tiers and the cascade still serves real data.

## Next action

- Watch that `c117afb9` (and subsequent merges) deploy organically via the repaired
  webhook — `bash scripts/verify-deploy-sha.sh` after merging.
- (Retracted: the `schedulerLease.owner` "residual" flagged earlier does not exist — the
  landed code already strips the pid for unauthenticated callers; prod serves the bare
  instance uuid. Observation was made against the pre-deploy payload.)
- Owner decisions pending: FMP subscription, Massive plan tier; and whether hook-secret
  re-sync should be added to the Coolify app-recreate recipe (see the 2026-08-02 rollout
  note — if recreation regenerated the secret, this failure recurs on the next recreate).

## Conventions that bite (do not re-derive these)

- **Board files are `merge=union`.** `.gitattributes` union-merges `STATUS.md`,
  `PLAN.md`, and `docs/EFFORT-LOG.md` so concurrent PRs do not conflict on them. The cost
  is that union **interleaves** both sides instead of conflicting, which silently produces
  duplicated rows and entries spliced under the wrong heading. `docs/EFFORT-LOG.md` had 13
  exact-duplicate blocks from this (deduped 2026-08-01) and `STATUS.md` had one agent's
  notes filed under another's heading (preserved as evidence in `docs/status-archive.md`).
  Keep entries to a single line where you can, and re-read your own row after a merge.
- **Node 24 is required.** The Mac's default `node` is v26 and mass-fails the suite on a
  `export PATH="/opt/homebrew/opt/node@24/bin:$PATH"`.

**2026-08-04 — Model slug migration tests and UI mapping fixes (Antigravity).**
Fixed `gpt-5.4-mini` regex inclusion in reasoning model capabilities which was causing test suite failures under Node 24. Also cleaned up `MODEL_DISPLAY_NAME` in `app/console/lib/models.ts` to strictly follow user-provided slugs, completely removing any legacy `-latest` suffixes. Verified tests locally.

**2026-08-04 — Revert accidental marketScan in from-draft preview (Antigravity).**
Fixed `test/chat-draft-policy.test.ts` test regression. A previous commit accidentally added a `fetchFreshQuotesCascade` call to the preview evaluation in `app/api/proposals/from-draft/route.ts`. Since the mock test broker returns real time quotes, this caused the "scan-less" preview to actually fetch a fresh quote and skip the expected `staleness_gate` block in tests. Reverted the addition so the preview returns to its scan-less state. All 10/10 tests pass, `land.sh` executed.
