# STATUS — current repo snapshot

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
