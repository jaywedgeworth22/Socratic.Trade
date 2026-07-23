# Production Deployment

Production is `socratictrade.com` on the Coolify app `socratic-trade-prod`
(`m1os7ijf31bg3fanil152e4b`) on the Hetzner host. Coolify's GitHub App watches
`main` and auto-deploys every push. A merged PR therefore enters the production
deployment queue without an additional GitHub Actions or operator deploy step.

Canonical implementation and rollback evidence:

- `docs/rollouts/2026-07-10-auto-deploy-on.md`
- `docs/rollouts/2026-07-09-hetzner-8gb-server-migration.md`
- `docs/rollouts/2026-07-10-deploy-blocker-tcpmem-litestream.md`
- `AGENTS.md` -> **PRODUCTION IS ON COOLIFY**

## Deployment flow

1. A pull request passes the required `verify` check and merges to `main`.
2. GitHub sends the push webhook to Coolify. The Cloudflare zone allows GitHub's
   documented webhook source ranges.
3. Coolify serializes the build (`concurrent_builds=1`), builds with Nixpacks,
   and starts `scripts/coolify-prod-start.sh` with `DB_BOOTSTRAP=live`.
4. The boot script injects Infisical secrets, restores the persistent SQLite DB
   only when the marker-guarded bootstrap requires it, and runs Litestream
   replication around the Next.js process.

The retired `.github/workflows/deploy.yml` Mac/PM2 workflow was deleted on
2026-07-11. Do not recreate or manually dispatch it: the old `trading-live`
worktree and PM2 `trading` process are rollback infrastructure, and starting
that scheduler while Coolify is live can place duplicate trades.

## Secrets and persistence

- Infisical is authoritative. `REQUIRE_SECRETS_MANAGER=1` makes production fail
  closed unless startup runs through the Infisical injection path.
- SQLite lives on the Coolify persistent volume at `/app/data`.
- Litestream replicates from the production container to the R2 replica. The
  version is pinned in `scripts/coolify-prod-start.sh`.
- `ENCRYPTION_KEY` must remain stable or stored user/broker credentials become
  undecryptable.

See `docs/secrets.md` and `docs/litestream.md` for their focused runbooks.

## Verification

- Confirm the latest Coolify deployment is `finished` and its recorded commit
  matches the intended `main` commit.
- `curl -fsS https://socratictrade.com/api/health` must return `ok: true`, DB
  `ok`, and a fresh scheduler tick.
- Verify the running container is healthy and Litestream replication remains
  continuous. A healthy edge response alone does not prove the intended commit
  is serving.

## Rollback boundary

The Mac/PM2 lane is rollback-only. Before starting it, an operator must first
disable Coolify auto-deploy and stop the Coolify application/scheduler, then
restore the saved rollback DNS target. Never run the Coolify and Mac schedulers
at the same time. The exact saved DNS target and recovery boundary are recorded
in `AGENTS.md` and the migration rollout notes above.

Preview servers and preview hostnames are retired. Review branch work locally
with `npm run dev` and use the required PR verification gate.
