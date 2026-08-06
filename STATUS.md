## Current (2026-08-06 GROK user source settings)

**Per-user source knobs + FMP toggles restored; plan tiers for all market-data sources (branch `grok/plan-tiers-all-sources`).** Rollouts: `docs/rollouts/2026-08-06-user-source-settings-ui.md`, `docs/rollouts/2026-08-06-plan-tiers-all-data-sources.md`.

## 2026-08-05 GROK — multi-period TWR

## 2026-07-06 — Learned-context copy fix + browse/delete archive (CLAUDE, `agent/claude`)
Owner flagged awkward empty-state copy on the Learned Context approval queue and asked why the AI
doesn't auto-learn and let the user review/delete afterward. Answer: it mostly already does — the
`fact` tier is silent passthrough, never queued; only `risk`/`strategy-directive` (numeric limits,
sizing, leverage, authority) confirms first, and that's deliberate (ingested-document/inference
safety, not paternalism — see `docs/chat-multiuser-learning-design.md`). What was genuinely
missing: the "browse + delete what was silently learned" surface the design doc promised but never
built. Shipped both: reworded the empty-state copy; added `deleteLearnedContext` (ownership-scoped,
also the shared-contribution erasure path) in `src/lib/db-learning.ts`, new `GET
/api/learned-context` + `DELETE /api/learned-context/[id]` routes, client helpers, and a new
collapsed-by-default `LearnedFactsArchive` browse/delete component in
`app/console/approvals/learned-context.tsx` wired into the approvals page. New
`test/learned-context-delete.test.ts` (7 tests: ownership isolation, foreign-user 404, shared-row
erasure, audit trail, superseded-row exclusion). 8-angle adversarial review found no
correctness/security bugs (two correctness-adjacent candidates investigated and refuted with
concrete evidence — see rollout note). Branch had drifted far behind `origin/main`
(Coolify/Hetzner migration, mobile fixes, RAG/sizing/prompt-safety work); merged by hand after
reviewing every flagged overlap, re-verified full quartet on the merged tree: tsc clean, lint 0
errors, 283 files / 2843 tests green, build clean. **Merged as PR #998** (`1c0c20d3`).
**Deployed to production** 2026-07-06 21:30:29Z via `~/apps/trading-publish.sh` — verified
`/api/health` 200, `pm2 trading` stable (0 unstable restarts post-deploy), and the new
`/api/learned-context` route live (401 unauthenticated, not 404/500, confirming it shipped). See
`docs/rollouts/2026-07-06-learned-context-archive.md`.

erasure, audit trail, superseded-row exclusion). Full suite 258 files / 2518 tests green, tsc
clean, lint 0 errors. Owner asked for production release this pass — see PR/deploy details below
once landed. See `docs/rollouts/2026-07-06-learned-context-archive.md`.
## 2026-07-06 — Mobile console width overflow fix (PR open)
- **2026-08-05 — GROK — IN PROGRESS — Multi-period TWR: split at each deposit/withdrawal, chain account+SPY sub-period returns (branch `grok/twr-subperiod-spy-chain`).** Owner: $100 for 10d then $10 for 100d must be separate regimes geometrically linked.

## Active (GROK 2026-08-06)

- **Plan-tier research** (`grok/plan-tier-research`): correcting Connections quota maps from live vendor docs (ROIC 5/min free, Twelve Grow floor 55, Marketstack monthly, AV premium ladder). Rollout: `docs/rollouts/2026-08-06-plan-tier-research.md`. Owner: do not invent limits — re-verify on site.

## 2026-08-05 GROK — account return % fix

- **2026-08-05 — GROK — IN PROGRESS — Fix inflated account % return (synthetic paper curve + live tip TWR; isAllCash cash-first; capital-weighted closed-lot return).** Branch `grok/fix-account-return-pct`. Owner: Sandbox/Alpaca Paper/etc showed ~+50% despite ~$100k start and slight drawdown.

## Current (2026-08-06 GROK provider-neutral data sources + ROIC)

**Settings Data sources card (no FMP-special toggles); ROIC key+tier+fixed transcript API (branch `grok/roic-provider-tiers`).**
Connections: plan tiers for market data; ROIC free/starter/individual/professional quotas; env-key plan tier without re-paste; v3 earnings-calls fetch. Rollout: `docs/rollouts/2026-08-06-provider-neutral-data-sources-ui.md`.

## Current (2026-08-05 GROK multi-source RAG)

**Earnings transcripts + SEC full bodies + trade highlights in RAG (branch `grok/rag-multi-source-ingest`).**
Full 8-K/10-K/10-Q/earnings-transcript stay native; extractive `document-summary` /
`earnings-summary` abstracts for LLM proposal use; routing + coverage expanded; Infisical
8-K full-body + EarningsCalls daily knobs on. Rollout: `docs/rollouts/2026-08-05-rag-multi-source-ingest.md`.
## Current (2026-08-05 GROK API key plan tiers)

**Plan-tier dropdowns on Connections API keys (branch `grok/data-sources-overhaul`).** Optional market-data keys declare free/power/starter/…; persist `user_api_keys.plan_tier` (v70); `provider-tier-plan.ts` → `resolveProviderQuota` when env knobs unset; FMP marked Retired · CT-only. Rollout: `docs/rollouts/2026-08-05-api-key-plan-tiers.md`.

## Current (2026-08-05 GROK FMP/Quiver health OFF)

**FMP/Quiver intentional OFF on admin Connections + FMP policy defaults false (branch `grok/data-sources-overhaul`).** Retired vendors show muted OFF chip (not red STOPPED), excluded from stopped/degraded counts; DEFAULT_POLICY fmp* toggles false; Settings FMP card retired→Congress.Trade; keys POST rejects FMP. Rollout: `docs/rollouts/2026-08-05-fmp-quiver-health-off.md`.

## Current (2026-08-05 GROK provenance stamps)

**Provenance completeness on scan/cache/history (branch `grok/data-sources-overhaul`).** Cascade stamps sharesOutstanding+headlines; mergeQuoteData/bar fieldObservations; OHLC + history_cache_eod.source (v71); macro fieldSources; calendar observations. Rollout: `docs/rollouts/2026-08-05-provenance-stamps-completeness.md`.


**2026-08-05 — GROK team: data sources overhaul (IN PR).** Capability matrix + ROIC transcript scheduler; FMP/Quiver health OFF; soft expected-limit health; plan-tier key dropdowns; provenance stamps; CT FMP latency family OFF grey (Congress.Trade #1417). Branch `grok/data-sources-overhaul`. Rollouts under `docs/rollouts/2026-08-05-*-*.md` + umbrella `data-sources-overhaul`.

## Current (2026-08-05 GROK You're set card center)

**Collapsed readiness card vertical center (branch `grok/youre-set-card-vertical-center`).** Closed collapsible cards get balanced header padding + min-height so "YOU'RE SET" sits centered. Rollout: `docs/rollouts/2026-08-05-youre-set-card-vertical-center.md`.
## Current (2026-08-05 GROK mobile tab bar chrome gap)

**Mobile tab bar: close 80% of Safari chrome gap + continuous surface (branch `grok/mobile-tabbar-gap-and-chrome-bg`).** Measure gap above floating URL chrome; shift `.con-tabbar` down 80%; solid surface underlay for remaining gap + under translucent chrome so colder `--con-bg` no longer flashes around the address bar. Rollout: `docs/rollouts/2026-08-05-mobile-tabbar-chrome-gap.md`.

## Current (2026-08-05 GROK symbol-field-store)

**Durable shared `symbol_field_latest` (branch `grok/symbol-field-store`).** Per-field `as_of` + `fetched_at` for every market field on every symbol ever seen; cascade and scan write; interactive scan seeds from store so strategy_run audit bounding no longer blanks PE/EPS/div. Rollout: `docs/rollouts/2026-08-05-symbol-field-latest-store.md`.

## 2026-08-05 GROK — issues/effort sweep
- Open PRs armed: #2489 (P2.7/P2.8), #2445 (iOS SSE), #2443 (Tradier quotes).
- Residual branch `grok/issues-activity-audit-residual`: B4 Settings TOC + congress-share IfDue single-flight + evidence_age (id,timestamp) dedup + board hygiene.
- Confirmed already on main: #2459 batch, Coach→Insights, safeTopCandidates, most activity-audit P2/P3.

## 2026-08-05 GROK — P0 security residual tranche

- **P0-5** decryptValue rejects plaintext; OAuth legacy path gated by isEncryptedValue.
- **P0-4** audit hash chain schema v67 + verifyAuditChain.
- Confirmed already on main: P0-1/2/3, P1-1..7 mechanical.
- Branch `grok/p0-security-p1-mechanical`.

**2026-08-04 — GROK: Tradier Sandbox venue-aligned quotes (branch `grok/tradier-sandbox-venue-quotes`).**
Paper Tradier keeps ~15m delayed sandbox quotes as execution-authoritative (no fresher Alpaca/Yahoo
overlay); staleness ages `fetchedAt` not trade-time delay. Alpaca paper stays real-time cascade.
Rollout: `docs/rollouts/2026-08-04-tradier-sandbox-venue-quotes.md`.

## Current (2026-08-05 GROK closeout)

- Merged #2488 #2459 #2489 #2445 #2443. Closed issues #838 #837 #1319 #1320 #1321 #1322.
## Current (2026-08-05 GROK)

**2026-08-05 — GROK: issue batch #838/#837/#1319 (branch `grok/issues-batch-prompt-evidence`).**
Prompt fencing on outcome post-mortem + reflection LLM; headline first-seen v66 for
evidence-age receipts; approval-path HTTP 4xx → rejected_by_broker. Also unstuck PRs
#2443/#2444/#2445. Rollout: `docs/rollouts/2026-08-05-issues-prompt-safety-headline-placement.md`.

**2026-08-04 — GROK: auto-pause strategy when broker cannot place orders (branch `grok/auto-pause-unplaceable-broker`).** If order path is down (Tradier OMS 500s, Alpaca trading_blocked, infra place failures, unfunded), flip `systemState` to `halted` with auto-resume marker so cadence stops burning LLM on unplaceable proposals; recover when probe healthy. Rollout: `docs/rollouts/2026-08-04-auto-pause-unplaceable-broker.md`.
**2026-08-04 — GROK: expert panel UX — Run once single primary (PR-A6).** Branch `grok/ux-expert-review-dup-run-once`. Owner: two Run once within ~1 inch. Four-expert review of web+iOS; chrome/home owns one primary; removed cadence/readiness/Guardrails/Insights duplicates; Zap icon; Approve live always labeled; iOS LIVE/PAPER + tappable attention. Review: `docs/reviews/2026-08-04-expert-panel-web-ios-ux.md`. Rollout: `docs/rollouts/2026-08-04-ux-run-once-single-primary.md`.

**2026-08-04 — GROK: iOS Sign-In constraint + SSE events (-1017).** Branch `grok/ios-constraint-and-sse-fix`. Cap Apple Sign-In button at 375pt; dedicated SSE request (`Accept: text/event-stream`, 120s idle timeout); quiet reconnect when snapshot already loaded. AG's 2026-08-03 constraint fix never reached main — lands here. Rollout: `docs/rollouts/2026-08-04-ios-signin-constraint-and-sse-events.md`.


## Current (2026-08-05 GROK activity-audit)

- P2.7/P2.8: multi-poll cancel settle + `protective_exit_failing` notification (branch `grok/activity-audit-p2-7-8`, issues #1320/#1321). Rollout: `docs/rollouts/2026-08-05-activity-audit-p2-7-8.md`.
- Unstuck phantom-conflict open PRs #2459 #2445 #2443 (merge main + re-arm auto-merge; CI re-running).
## Current (2026-08-05 GROK)

- Framework proposals: all 3 prod rows set to **rejected** after agent review (PG/T hard accounting gates; BAC unfilled red-team override). UI reopen/change-of-mind on branch `grok/framework-proposal-review`. Rollout: `docs/rollouts/2026-08-05-framework-proposal-review-reopen.md`.
## Current (2026-08-04 GROK)

- iOS TestFlight agent ship: `bash scripts/ios-ship-testflight.sh` (fleet README `/Users/jay/apps/ios-fleet/README.md`).

**2026-08-04 — GROK: UX Wave B IA (B1/B2/B4) — PR #2425.** Branch `grok/ux-wave-b-ia`.
Plain nav labels Home/Scan/Activity/Results/Macro via `DESTINATIONS` + `destinationLabel`;
Guardrails Autonomy panel (`#autonomy`) with run state/authority/cadence/readiness + chrome Run
controls; Settings sticky TOC. B3 via #2426 on main; no policy defaults; A4 `defaultOpen={false}`
preserved. Supersedes #2413/#2419. Rollout: `docs/rollouts/2026-08-04-ux-wave-b-ia.md`.
**2026-08-04 — UX PR-A2 approval density (GROK, branch `grok/ux-a2-approval-density`).** Approval cards default collapsed (side/symbol/size, Live/Paper, AI-critic chip, 2–3 line thesis); "Show full reasoning" restores full receipt; sticky mobile Approve/Reject above tab bar. No approve-API changes. Rollout: `docs/rollouts/2026-08-04-ux-a2-approval-density.md`.
**2026-08-04 — GROK: UX PR-B1 plain nav labels (branch `grok/ux-b1-plain-nav`).** Owner D2:
Thesis→Home, Evidence→Scan, Journal→Activity, Outcomes→Results, Regime→Macro. `desc`
tooltips keep metaphor; home CTAs use `destinationLabel`; mobile pins already by href.
Rollout: `docs/rollouts/2026-08-04-ux-b1-plain-nav-labels.md`.
**2026-08-04 — GROK: retire direct FMP / QuiverQuant / Unusual Whales.** Owner:
Socratic.Trade must not call those vendors. Congressional disclosures/analytics from
Congress.Trade (default ON); **fundamentals from multi-source cascade** (Yahoo/Finnhub/
ROIC/SEC/… — App A fundamentals default OFF). Hard ban at registration + request choke
points. Branch `grok/no-direct-fmp-quiver-uw` (PR #2398).
Rollout: `docs/rollouts/2026-08-04-retire-direct-fmp-quiver-uw.md`.

**2026-08-04 — Final Verification of Model Slugs (AG).** Branch `agent/antigravity/openrouter-classifiers`. Replaced all legacy `-latest` model slugs with Provider Native Slugs (`gpt-5.6-sol`, `gpt-4o`, etc.) across the codebase. Cleaned up duplicate properties in model configuration files. Fixed test regressions in history tests by adding DB isolation to `historyTestDb` shared per-file. Fixed `isGpt56Model` regex. Gates verified: tsc clean, lint clean, full test suite passes. Landed cleanly via `land.sh`.
Rollout: `docs/rollouts/2026-08-04-model-slug-test-fixes.md`.

**2026-08-04 — GROK: UX PR-A4 + PR-A5 (guardrails Advanced collapsed + PWA Proposals noun).**
PR #2411, branch `grok/ux-a4-a5-quick`, auto-merge armed. Advanced rulebook `defaultOpen={false}`; Essentials open; PWA
heading Approvals → Proposals. Display-only. lint+tsc clean. Rollout:
`docs/rollouts/2026-08-04-ux-a4-a5-guardrails-nouns.md`.


# STATUS — current repo snapshot

**2026-08-04 — GROK: Congress filing-date member skill → ST.** Prefer CT `filingDate`
copy-trade skill (shared package v2.5.0 dual performance); restore `memberSkill` weight
0.2; persist raw avgExcess/winRate/scoredCount on quotes + signal_snapshot. Branch
`grok/congress-filing-skill`. Rollout:
`docs/rollouts/2026-08-04-congress-filing-member-skill.md`.
**2026-08-04 — GROK: quote cascade freshness + never block on stale.** Cascade accept = maxQuoteAgeSec (120s) so ~15m delayed feeds no longer stop the cascade; if still stale, convert opening to limit at proposal.referencePrice (never block/escalate). Branch `grok/fix-quote-freshness`.

**2026-08-04 — GROK: UX B3+E2+E3 polish (branch `grok/ux-b3-e-polish`).** Strategy page collapsible sections (Models + Instructions open; Scoring weights collapsed; Presets open). Login page three value bullets matching iOS. Command palette trigger always visible on mobile chrome (icon-only below sm). Healthy mobile freshness collapses to one line. No policy changes. Rollout: `docs/rollouts/2026-08-04-ux-b3-e-polish.md`.


**2026-08-04 — GROK: retire direct FMP/Quiver/UW; fundamentals multi-source.** Hard ban
on direct FMP/Quiver/UW. Congress.Trade for disclosures/analytics (default ON);
fundamentals from the multi-provider cascade (App A fundamentals default OFF). PR #2398.
**2026-08-05 — iOS Light App Icon Sync (ANTIGRAVITY, branch `agent/antigravity`).** Replaced the canvas-drawn `icon.svg` with the iOS App Icon (PNG) across `public/icon.png`, `public/icons/icon-192.png`, `public/icons/icon-512.png`, and `public/icons/apple-touch-icon-180.png`. Updated `app/manifest.ts` and `app/layout.tsx` to serve the static PNGs instead of the SVG to fix visual glitches/inconsistencies. Rollout: `docs/rollouts/2026-08-05-ios-light-app-icon-sync.md`.

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

Last updated: 2026-08-05 (GROK: UX program Waves A–E complete).
Last updated: 2026-08-04 (GROK: UX Wave C speed C1–C4).
Last updated: 2026-08-04 (GROK: UX Wave B IA landing).
Last updated: 2026-08-04 (GROK: UX PR-A3 first-run readiness checklist — PR #2417).
Last updated: 2026-08-04 (GROK: UX Wave D mobile/iOS/PWA).

**2026-08-04 — GROK: UX Wave D mobile/iOS/PWA parity (branch `grok/ux-wave-d-mobile`).**
D1 brand teal `#12616f` / dark `#58c7d3`; D2 Home readiness checklist + ready hero with
Review→Proposals tab switch; D3 per-proposal command feedback (iOS MobileStore + ProposalsView,
PWA card strip); D4 humanized command labels, Ask-first/Autopilot, Proposals section title,
control-remote framing. Rollout: `docs/rollouts/2026-08-04-ux-wave-d-mobile.md`.


## UX Wave C speed (2026-08-04, GROK)

**IN PR** branch `grok/ux-wave-c-speed`. C1 snapshot TTL cache (userId×accountNumber, 10s,
invalidate on policy/approve/reject); C2 FIFO `calculatePnl` once + PrefetchedPnl to
scorecards/tax; C3 scan `TableVirtuoso`; C4 `React.memo` leaves + home `useMemo` derives.
Rollout: `docs/rollouts/2026-08-04-ux-wave-c-speed.md`. Program:
`docs/design/ux-improvement-program.md` §Wave C.

## UX improvement program (2026-08-04, GROK)

Sequenced PR plan: `docs/design/ux-improvement-program.md`.
**PR-A1 honest skip statuses** — IN PR #2418 (`grok/ux-a1-honest-skips`): granular
`skipped_budget` / `skipped_market_closed` / `skipped_broker_unhealthy`; Thesis/Activity
chips; liveness/auto-tune honesty. Rollout: `docs/rollouts/2026-08-04-ux-a1-honest-skips.md`.
PR-0: `docs/rollouts/2026-08-04-ux-improvement-program.md`.
Sequenced PR plan: `docs/design/ux-improvement-program.md`. **Wave B IA** (B1 plain labels,
B2 Autonomy panel, B4 Settings TOC) on branch `grok/ux-wave-b-ia` — rollout
`docs/rollouts/2026-08-04-ux-wave-b-ia.md`. Wave A slices remain claimable. Program rollout:
`docs/rollouts/2026-08-04-ux-improvement-program.md`.
Sequenced PR plan for web console + PWA + iOS after a full-product review:
`docs/design/ux-improvement-program.md`. Wave A/B/C/D slices claimed by implementer
fleet — coordinate via effort board. Rollout:
`docs/rollouts/2026-08-04-ux-improvement-program.md`.
`docs/design/ux-improvement-program.md`. **PR-A3 first-run checklist IN PR**
(`grok/ux-a3-checklist` / #2417 — `deriveReadinessChecklist` + Thesis hero).
Program rollout: `docs/rollouts/2026-08-04-ux-improvement-program.md`. A3 rollout:
`docs/rollouts/2026-08-04-ux-a3-first-run-checklist.md`.
`docs/design/ux-improvement-program.md`. Wave D (mobile/iOS/PWA) implemented on
`grok/ux-wave-d-mobile`. Remaining A/B/C slices stay Planned/UNASSIGNED until claimed.
Rollouts: `docs/rollouts/2026-08-04-ux-improvement-program.md`,
`docs/rollouts/2026-08-04-ux-wave-d-mobile.md`.


## UX program complete (2026-08-05, GROK)

All sequenced UX waves A–E from `docs/design/ux-improvement-program.md` are **merged to main** (auto-deploy). Key PRs: #2411 A4+A5, #2413 B1, #2414 A2, #2417 A3, #2418 A1, #2423 C, #2424/#2431 D, #2425 B2/B4, #2426 B3+E. Rollout: `docs/rollouts/2026-08-05-ux-program-complete.md`. Deferred: E1 empty-state system, unauth apex→welcome.

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
