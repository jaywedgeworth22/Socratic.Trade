# 2026-07-07 — Migrate PRODUCTION socratictrade.com to the Coolify box (MONET, owner-directed)

Owner asked in-session: "can you migrate the production site to coolify server at
jays.services?" This note records the design, the repo additions, and (updated as it
happens) the cutover. Follow-up to `docs/rollouts/2026-07-07-coolify-lane-deploys.md`,
which migrated the preview lanes and explicitly deferred production.

## Summary

Production moves from the Mac (`~/apps/trading-live`, pm2 `trading` -> `next start` :4000,
served via Cloudflare Tunnel) to a new Coolify application on the Hetzner box
(`91.98.44.8`, Coolify v4.1.2 at `https://jays.services`). New app
`socratic-trade-prod`: GitHub App source, branch `main`, nixpacks, port 3000,
**auto-deploy OFF** (production releases remain a deliberate owner/agent-run step, same as
the old `~/apps/trading-publish.sh` model — merging to `main` still only auto-deploys the
integration preview).

Key design points:

- **Secrets stay in Infisical.** The app boots via `scripts/coolify-prod-start.sh`
  (new), which installs pinned `infisical` CLI **0.43.98** + `litestream` **0.5.14**
  binaries onto the persistent volume, then self-wraps in `scripts/infisical-run.mjs`
  (same runner production used on the Mac; `REQUIRE_SECRETS_MANAGER` stays enforced).
  Coolify env holds only the Infisical universal-auth identity (`INFISICAL_*`, values
  copied from the Mac's pm2 `trading` env — note `INFISICAL_ENV=prod`, not
  `production`) plus `NIXPACKS_NODE_VERSION=24`, `NIXPACKS_PKGS="gnutar gzip"`,
  and the `DB_BOOTSTRAP` gate.
- **DB migrates via the existing litestream replica.** The Mac's litestream sidecar has
  been replicating `data/app.db` (113 MB) to R2 (`trading-live/app.db` path). The new
  `litestream.coolify.yml` points at the same replica with the container path
  `/app/data/app.db`. At cutover the container restores from that replica (one-time,
  marker-file-guarded), then runs `litestream replicate -exec "npm run start"` so
  PITR backup continuity is preserved on the box. Litestream versions are pinned equal
  (0.5.14 wrote the replica; 0.5.14 restores it — LTX format compatibility).
- **Double-scheduler safety.** `DB_BOOTSTRAP=fresh` (initial state) starts the app on an
  empty DB: no users, no broker accounts, scheduler cannot place orders — safe to build
  and verify while Mac production is still live. Only after pm2 `trading` + `litestream`
  are stopped on the Mac is `DB_BOOTSTRAP` flipped to `live` (runtime env change +
  container restart, no rebuild) to restore the real DB. This matters doubly because
  `main` (#1036) flipped `ALLOW_LIVE_TRADING` to opt-OUT, and the Infisical prod env does
  not set it — the connected Robinhood live account trades on its environment as soon as
  a scheduler runs against the restored DB (verified: current Mac prod already runs
  `e73c66a4` with the same env, so this is parity, not a behavior change).
- **Persistent volume** mounted at `/app/data` (SQLite DB + `.bin` tool cache +
  `logos/` cache re-populates on demand).
- **Domains/DNS.** App FQDNs: `http://socratictrade.com` + `http://prod.jays.services`
  (origin serves HTTP; Cloudflare proxies terminate TLS at the edge — same scheme as the
  preview lanes). `prod.jays.services` gets a proxied A record to `91.98.44.8` first for
  verification; cutover then flips `socratictrade.com` from its tunnel CNAME
  (`6b807051-....cfargotunnel.com`) to the same proxied A record.
  `admin.socratictrade.com` currently 404s through the tunnel (no ingress rule) and is
  left untouched.

## Rollback

Restore the `socratictrade.com` proxied CNAME to `6b807051-38ab-4062-8d52-0cddf1d66657.cfargotunnel.com`,
then on the Mac: `pm2 start trading litestream` (worktree `~/apps/trading-live` is left
fully intact, DB included). Any writes made on the box after cutover are lost to the Mac
copy but survive in the R2 replica (the box replicates to the same path).

## Files

- `scripts/coolify-prod-start.sh` (new) — phase-1 binary bootstrap + phase-2
  `DB_BOOTSTRAP` gate described above. ASCII-only per repo shell-script rule.
- `litestream.coolify.yml` (new) — container-path litestream config, env-interpolated,
  no secrets.
- `docs/rollouts/2026-07-07-prod-coolify-migration.md` (this note)
- `STATUS.md`, `docs/EFFORT-LOG.md`, `AGENTS.md` — migration state recorded.

## Verification

- Pre-work: confirmed prod pm2 env (`INFISICAL_ENV=prod`), `DATABASE_URL=file:./data/app.db`
  (relative — container-safe), `LITESTREAM_S3_*` present in the injected env (5 keys),
  `ALLOW_LIVE_TRADING` unset, Mac litestream binary 0.5.14, release-asset URLs for both
  pinned binaries return 200.
- `npm run lint` / `npx tsc --noEmit` / `npm test` / `npm run build` run before landing
  (this PR adds only shell/yaml/docs, but the verify gate runs regardless).
- Cutover verification (RESULTS APPENDED BELOW WHEN DONE): app `running` +
  `✓ Ready` in runtime logs, restore marker written, `https://socratictrade.com` serves
  200 with real data, `/api/health` ok, scheduler ticking.

## Status / cutover log

- 2026-07-07 ~23:00 CDT — plan + repo additions written; Coolify app creation next.
  (This section is updated as the migration proceeds.)

## Follow-ups

- Consider `limits_memory` on the prod app container (box is 4 GB; builds already
  serialize via `concurrent_builds=1`, runtime caps not yet set).
- Decommission plan for the Mac lane (pm2 delete + tunnel route removal) only after a
  soak period — keep as rollback target for now.
- Rotate/trim the old `app.db.backup-*` files on the Mac (not migrated).
