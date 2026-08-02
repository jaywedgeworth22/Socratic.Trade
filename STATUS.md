# STATUS — current repo snapshot

Snapshot only: what is true right now, what is blocked, what to do next. This file is
**not** a changelog. Chronological history lives in `docs/rollouts/` (one note per piece
of work), effort state lives in `docs/EFFORT-LOG.md`, and entries written here before
2026-08-01 were moved to `docs/status-archive.md`.

Last updated: 2026-08-02.

## Where things stand

**2026-08-02 — Mobile PWA owner-feedback round (Monet, cloud session).** Branch
`agent/antigravity/mobile-pwa-feedback` (applying patch from Monet): PWA gets
an Accounts section (switch broker account via `account.activate`, sign-out link to switch Google/Apple
login), per-proposal realtime approve/reject feedback (tapped button spins; card follows its queued
command through queued/running/succeeded/failed instead of failures hiding in the Command Log), and the
delete-account panel is collapsed behind a neutral link so it stops mimicking error banners. tsc clean,
mobile test file 10/10, lint 0 errors. Landing to main via `scripts/land.sh`.
Rollout: `docs/rollouts/2026-08-02-mobile-pwa-owner-feedback.md`.

| | |
|---|---|
| `main` | `c117afb9` — includes the full 30-finding Codex remediation (#2341, AG-reviewed) and the npm `allowScripts` fix (#2345) |
| Production (`socratictrade.com`) | `19dfd51b` verified live 2026-08-02 ~04:47Z (`scripts/verify-deploy-sha.sh` PASS); `c117afb9` should follow via the repaired webhook |
| Deploy mechanism | auto-deploy on push to `main` — **repaired 2026-08-02** (webhook HMAC secret was mismatched; see blocker 1) |
| Core trading health | DB ok, scheduler ticking, 3 active accounts / 0 degraded, litestream replicating |
| Data providers | `dataProvidersDegraded=true` — FMP plan probe 403, Massive capped to ~2y history |

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

2. **RESOLVED 2026-08-02 (PR #2345) — npm 11.16 `EALLOWSCRIPTS` on the shared git dep.**
   `npm install`/`npm ci` failed preparing `congress-trading-shared` and left `node_modules`
   EMPTY (easily misread as janitor reaping); the interim workaround was `npx -y npm@10 ci`.
   #2345 restored the `allowScripts` entry for the current tag and regenerated the lockfile
   for shared v2.4.1. If plain `npm ci` regresses again after a future shared-package bump,
   check that `package.json`'s `allowScripts` key names the CURRENT `#vX.Y.Z` spec — a
   stale tag reproduces the identical failure.

3. **Two provider lanes are degraded and need an owner decision, not an agent fix.**
   FMP's plan probe returns 403 (subscription state) and Massive is history-capped to the
   free tier. Agents must not provision replacement keys. Several optional/telemetry lanes
   (Usage Monitor, VIX-Yahoo, Nasdaq Quote, some RapidAPI lanes) are also down; those are
   fallback tiers and the cascade still serves real data.

## Next action

- Watch that `c117afb9` (and subsequent merges) deploy organically via the repaired
  webhook — `bash scripts/verify-deploy-sha.sh` after merging.
- Small follow-up in flight: fold `schedulerLease.owner` behind the ops token on
  `/api/health` (the one residual of finding 27's minimization).
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
  `better-sqlite3` ABI mismatch. Prefix gate commands with
  `export PATH="/opt/homebrew/opt/node@24/bin:$PATH"`.
