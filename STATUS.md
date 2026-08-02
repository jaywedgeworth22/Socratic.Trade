# STATUS — current repo snapshot
## 2026-08-01 — Per-Broker Order-Status Conformance Tables (oss-lessons §7 slice 1) (KIMI) — PR #2335

freqtrade discipline locked into CI: the shared classifiers in `broker-side.ts` / `broker-held-orders.ts` are the single interpretation point for raw broker status strings, and `src/lib/broker-status-conformance.ts` now maps every documented raw status of alpaca/robinhood/tradier to its canonical class across the four production lenses (live/active/working/decline/filled), executed against the REAL classifiers by 7 new conformance tests — a vocabulary or classifier edit in either direction is a CI failure, not a production surprise. Audit finding fixed: `broker-held-orders.ts`'s drifted local decline set (missing `failed`/`error`, zero importers) is replaced by a re-export of canonical `broker-side.isRejectedOrCanceledState` — the two modules can never diverge again. Tables pin the documented traps: `done_for_day` terminal-inert (2026-07-27 inflation), `pending_cancel`/`pending_replace` deliberately live, `replaced` ≠ decline, `calculated`/`stopped` EXTRA_WORKING delimited, unknowns fail CLOSED. Gates: tsc clean, eslint 0 errors, targeted 46/46, full suite 5553/5553 (3 shards), build green — all in dedicated clean worktree `~/apps/trading-kimi-s7`. Branch `kimi/broker-status-conformance`. Rollout: `docs/rollouts/2026-08-01-broker-status-conformance.md`. §7 slices 2–4 (order-type constraint validation, per-account broker-mutation mutex, uniform protection receipts) remain planned/unassigned.

## 2026-08-01 — Free-tier cascade gap-fills + R2 kill-switch + litestream socket fix + stuck orders (KIMI) — branch `agent/kimi-lane`

Owner directives batch: (1) FREE-TIER CASCADE — ground-truth audit (`scripts/cascade-audit.ts`) found 19 unpopulated enrichment fields; Yahoo's already-fetched financialData now maps analyst targets (mean/high/low/median), revenueGrowth, and freeCashFlowYield, and quiver keys resolve from `QUIVERQUANT_API_TOKEN` too — gaps down to 8 (bid/ask/vwap = Alpaca tier present in prod + weekend-empty; IV/PCR = opt-in Robinhood options, now ENABLED in prod Infisical; senateTrades = congress.trade present in prod; insiderSentiment = only true gap, SEC Form 4 follow-up filed). (2) R2 — daily usage report (once/24h notify) + kill-switch: on pace >70% of free tier in a live boot, writes `/app/data/.litestream-r2-disabled`, restarts the container WITHOUT litestream (start-script honors the marker), resume via `POST /api/admin/r2-usage/resume`. (3) LITESTREAM — the "unknown" alarm was a wrong socket path (0.5.12 listens at `<db-dir>/litestream.sock`, ignoring config `socket.path`); probe now tries legacy + db-dir candidates; replication was healthy all along (prod now `known/ipc`). (4) STUCK SELLS — AAPL/JNJ trailing stops had already FILLED; EA/AFL/BAC trailing stops on Alpaca Paper canceled (HTTP 204 ×3); the app's stop monitor re-placed EA per its stop plan (sell-vs-protect decision flagged to owner). Also survived/documented the 03:14–04:00 UTC prod outage from another operator's docker data-root migration. 8 new tests (175/175 targeted green, tsc/lint clean; full suite+build delegated to CI verify under host load). Rollout: `docs/rollouts/2026-08-01-free-tier-cascade-r2-killswitch.md`.
## 2026-08-01 — CBOE-First VIX Cascade Optimization (ANTIGRAVITY)

Re-ordered keyless ^VIX fetch cascade in `src/lib/macro.ts` to query CBOE delayed quotes (`vix-cboe`) first and Yahoo Finance (`vix-yahoo`) second. CBOE operates a keyless, public CDN that does not rate-limit or block datacenter IPs. Eliminates recurring 429 errors from Yahoo Finance on datacenter IPs.

All tests, tsc, and Next.js build pass cleanly. Rollout: `docs/rollouts/2026-08-01-cboe-first-vix-cascade.md`.
## 2026-08-01 — Time-Bounded (PIT) Proposal Evidence for the Auto-Tuner (KIMI) — PR #2327

Snapshot only: what is true right now, what is blocked, what to do next. This file is
**not** a changelog. Chronological history lives in `docs/rollouts/` (one note per piece
of work), effort state lives in `docs/EFFORT-LOG.md`, and entries written here before
2026-08-01 were moved to `docs/status-archive.md`.

Last updated: 2026-08-01.

> [!IMPORTANT]
> **Work in progress on `monet/codex-review-remediation` is PAUSED (owner instruction).**
> Wave 1 is committed locally as `e7a1b65c` — **not pushed, no PR**. Wave 2 is on disk,
> **uncommitted and completely unreviewed** (6 agents stopped mid-flight; `tsc` is clean but
> tests and lint have never run against it). Do not treat it as correct, and do not land it
> without reviewing it first. Resume instructions, the file→finding map, and the
> union-merge trap that will bite on the next `origin/main` merge:
> `docs/rollouts/2026-08-01-codex-review-remediation-handoff.md`.

## Where things stand

| | |
|---|---|
| `main` | `ad1c1d5c` — CI green, no known failing gate |
| Production (`socratictrade.com`) | `d456ca58` — **5 commits behind `main`, and not advancing** |
| Deploy mechanism | auto-deploy on push to `main` (Coolify `socratic-trade-prod`) |
| Core trading health | DB ok, scheduler ticking, 3 active accounts / 0 degraded, litestream replicating |
| Data providers | `dataProvidersDegraded=true` — FMP plan probe 403, Massive capped to ~2y history |

## Blockers

1. **Production is behind `main` and auto-deploy is not closing the gap — OWNER ACTION.**
   Live health reported `d456ca58` at 21:33Z and *still* reported `d456ca58` more than an
   hour later, while `main` advanced from `88e614d7` to `ad1c1d5c`. That is 5 commits
   merged and not running, and the gap is growing, so this is not a slow build. Merging is
   currently **not** evidence that anything shipped.

   Verify before believing a change is live:
   ```bash
   bash scripts/verify-deploy-sha.sh            # defaults to origin/main
   ```
   Agents must NOT hand-trigger a Coolify deploy (manual deploy claims/triggers are
   retired). The likely causes are on the Coolify side — a wedged/zombie `in_progress`
   deployment blocking the queue, or the GitHub webhook not being delivered — and both need
   the owner at the dashboard.

2. **Local verification is broken on npm 11.16 (all agent lanes).** `npm install` and
   `npm ci` both fail preparing the `congress-trading-shared` git dependency:
   `EALLOWSCRIPTS — --allow-scripts is not allowed in project-scoped installs`. npm invokes
   its own nested install with that flag during git-dep preparation, and `package.json`'s
   `allowScripts` field does not satisfy it. The failure leaves `node_modules` **empty**, so
   it looks like the janitor reaped it. Workaround that works today:
   `npx -y npm@10 ci --no-audit --no-fund`. CI is unaffected (it installs on
   `ubuntu-latest` via `actions/setup-node`). Needs a durable fix — pinning `packageManager`
   or vendoring the shared package are the candidates.

3. **Two provider lanes are degraded and need an owner decision, not an agent fix.**
   FMP's plan probe returns 403 (subscription state) and Massive is history-capped to the
   free tier. Agents must not provision replacement keys. Several optional/telemetry lanes
   (Usage Monitor, VIX-Yahoo, Nasdaq Quote, some RapidAPI lanes) are also down; those are
   fallback tiers and the cascade still serves real data.

## Next action

- Confirm production actually advances to `main` on the next merge, using the SHA
  verifier rather than assuming.
- Land the durable fix for the npm 11.16 install failure — every agent lane currently
  needs the `npm@10` workaround to run the gates locally.
- Owner decisions pending: FMP subscription, Massive plan tier.

## Conventions that bite (do not re-derive these)

- **Board files are `merge=union`.** `.gitattributes` union-merges `STATUS.md`,
  `PLAN.md`, and `docs/EFFORT-LOG.md` so concurrent PRs do not conflict on them. The cost
  is that union **interleaves** both sides instead of conflicting, which silently produces
  duplicated rows and entries spliced under the wrong heading. `docs/EFFORT-LOG.md` had 13
  exact-duplicate blocks from this (deduped 2026-08-01) and `STATUS.md` had one agent's
  notes filed under another's heading (preserved as evidence in `docs/status-archive.md`).
  Keep entries to a single line where you can, and re-read your own row after a merge.
- **Node 24 is required.** The Mac's default `node` is v26 and mass-fails the suite on a
  `better-sqlite3` ABI mismatch. Prefix gate commands with
  `export PATH="/opt/homebrew/opt/node@24/bin:$PATH"`.
