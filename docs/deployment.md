# Production Deployment

Production is **[socratictrade.com](https://socratictrade.com)** on Coolify app
**uuid `socratic-app`** (name "Socratic.Trade", branch `main`, dockerfile build pack).

**Host (current):** Coolify on Hetzner (`167.233.254.55`; dashboard/API
`https://host.jays.services`). Oracle Cloud (`141.148.182.224`) was the prior
prod host until the 2026-08 fleet cutover — treat Oracle IPs and old app uuids
in historical rollouts as archival, not live targets.

**Auto-deploy:** every push to `main` triggers Coolify via the repo webhook to
Coolify's **manual** GitHub webhook endpoint
(`https://host.jays.services/webhooks/source/github/events/manual`), not the
GitHub-App integration alone. HMAC must match the app's
`manual_webhook_secret_github`. Merge == live; do **not** post deploy claims or
manually trigger deploys (ANNOUNCE-THEN-DEPLOY is retired).

Canonical detail:

- `docs/rollouts/2026-07-10-auto-deploy-on.md`
- `docs/rollouts/2026-08-07-hetzner-fleet-cutover.md` (and ops follow-up notes)
- `docs/rollouts/2026-08-02-deploy-webhook-secret-repair.md` (webhook signature drift)
- `AGENTS.md` → production / Coolify stanzas

## Deployment flow

1. A pull request passes the required `verify` check and merges to `main`
   (prefer `gh pr merge <n> --squash --auto`).
2. GitHub delivers the push to Coolify's manual webhook (HMAC-validated).
3. Coolify serializes builds (`concurrent_builds` pinned to **1**), builds with
   the app's **Dockerfile** pack, and starts `scripts/coolify-prod-start.sh`
   with `DB_BOOTSTRAP=live`.
4. Boot injects Infisical secrets, restores SQLite when the marker-guarded
   bootstrap requires it, and runs Litestream (when R2 is enabled) around Next.js.

The retired Mac/PM2 publish path and Coolify PR previews are gone. Do not start
Mac `pm2` `trading` while Coolify runs `DB_BOOTSTRAP=live` (dual schedulers).

## Secrets and persistence

- Infisical is authoritative for production secrets.
- SQLite lives on the Coolify persistent volume at `/app/data`.
- Litestream → R2 when enabled; free-tier kill-switch and B2 offsite are covered
  in fleet ops rollouts. `ENCRYPTION_KEY` must remain stable or stored credentials
  become undecryptable.

## Verify after merge

```bash
bash scripts/verify-deploy-sha.sh   # live sha contains your commit
curl -sS https://socratictrade.com/api/health
```

CI: GitHub-hosted `ubuntu-latest` only (no self-hosted Mac/Oracle runner labels).

## Deploy freshness (silent-freeze watch)

`verify-deploy-sha.sh` is the post-merge assertion (polls up to 25 min).  It does
not watch the pipeline afterwards.  On 2026-08-06 five Coolify deploys died
mid-build (SSH exec stream exit 255) while webhooks returned 200 and
`/api/health` stayed green on the old sha for ~14h.

`.github/workflows/deploy-freshness.yml` runs `scripts/alert-deploy-freshness.sh`
every 20 minutes.  It fails (Sentry fleet-infra + optional `#agent-sync`) when
the oldest commit on `origin/main` that is not live is older than 1 hour.
Unreachable health is not this class (UptimeRobot pages site-down).  The
workflow never deploys and never calls Coolify.

Manual one-shot:

```bash
bash scripts/alert-deploy-freshness.sh origin/main
```

## Shared-box OCR isolation

ST, Congress.Trade, and Usage Monitor still share the Hetzner cx43.  CT OCR /
`scan-cpu-worker` batches on that box were the 2026-08-06 contention correlate.

```bash
bash scripts/isolate-shared-box-batch.sh                  # dry-run on the host
ISOLATE_SHARED_BOX_APPLY=1 bash scripts/isolate-shared-box-batch.sh --apply
```

The script never restarts a container and never matches Socratic.Trade, Coolify,
or Usage Monitor.  `--apply` requires the env latch.  `docker update` CPU limits
are ephemeral: the next CT Coolify recreate overwrites them.

**Remaining host constraint (this repo cannot lift it):**

- Durable isolation is a Coolify CPU limit on `congress-app`, a CT-repo
  nice/cpuset worker, or moving OCR off-box.
- If OCR is in-process inside `congress-app-live`, this script finds no worker.
  `--include-app` caps the whole CT app (also caps CT web).
- Coolify has no job-level retry-on-exit-255 that this repo can set.  Do not
  take prod down to experiment.
