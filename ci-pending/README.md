# CI / Deploy workflows — reference

All workflow definitions are now **active** in `.github/workflows/`:

- `ci.yml` — the required `verify` check (tsc → vitest → build)
- `security.yml` — gitleaks secret scan
- `e2e.yml` — Playwright smoke (`npm run test:e2e`)
- `deploy.yml` — production deploy on push to `main`

They were previously **staged here** because the agents' automated push path
(`scripts/land.sh`) refuses `.github/workflows/` diffs (the agents' token lacks the GitHub
OAuth `workflow` scope). The owner activated them with a workflow-scoped push. This
directory now keeps only the deploy/runner setup notes below as operations reference.

## Deploy workflow (`deploy.yml`)

Auto-deploys every push to `main` (i.e. every merged PR) to the self-hosted production
host: `git reset --hard origin/main` → `npm ci` → `npm run build` → `pm2 restart trading`
in `~/apps/trading-live`. Also exposes a manual **Run workflow** button.

Already active (was activated with `git mv ci-pending/deploy.yml .github/workflows/`).

It only resets **tracked** files, so `.env.local`, `data/app.db`, and `data/logos/` in the
production worktree are preserved. Any uncommitted hand-edits to *tracked* files on the prod
box would be discarded — commit or stash those first.

### Self-hosted runner setup (recommended — matches the PM2-on-your-own-box layout)

`deploy.yml` targets `runs-on: [self-hosted, trading-live]`, so GitHub hands the job to a
runner you register on the production machine. No inbound SSH is exposed; the box pulls jobs.

1. GitHub → repo **Settings → Actions → Runners → New self-hosted runner**; follow the
   Linux steps on the production host (run the runner as the user that owns
   `~/apps/trading-live` and can drive `pm2`).
2. When prompted for labels, add **`trading-live`** (the `self-hosted` label is automatic).
3. Install it as a service so it survives reboots: `sudo ./svc.sh install && sudo ./svc.sh start`.
4. Ensure `git`, `node` (24.x), `npm`, and `pm2` are on the runner service's `PATH`
   (PM2 installed globally; nvm users should point the service at the right Node).
5. Optional: set repo **Variables** `DEPLOY_DIR` / `PM2_APP` if your path or app name differ
   from the defaults (`$HOME/apps/trading-live`, `trading`).

### Alternative: deploy over SSH from a GitHub-hosted runner

Use this only if you prefer not to run a self-hosted runner AND the box is reachable over SSH
from GitHub's runners (e.g. a Cloudflare Tunnel `cloudflared access` SSH route or a public
port). Replace the `deploy` job's `runs-on`/`steps` with:

```yaml
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Deploy over SSH
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.DEPLOY_SSH_HOST }}
          username: ${{ secrets.DEPLOY_SSH_USER }}
          key: ${{ secrets.DEPLOY_SSH_KEY }}
          port: ${{ secrets.DEPLOY_SSH_PORT }}   # optional, defaults to 22
          script_stop: true
          script: |
            set -euo pipefail
            cd "${DEPLOY_DIR:-$HOME/apps/trading-live}"
            git fetch origin main && git checkout main && git reset --hard origin/main
            npm ci
            npm run build
            pm2 restart "${PM2_APP:-trading}" --update-env
            pm2 save
```

Required repo **Secrets**: `DEPLOY_SSH_HOST`, `DEPLOY_SSH_USER`, `DEPLOY_SSH_KEY`
(a dedicated deploy private key whose public half is in the box's `~/.ssh/authorized_keys`),
and optionally `DEPLOY_SSH_PORT`. Never commit the key — store it only as a secret.
