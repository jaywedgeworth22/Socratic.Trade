# Secrets: source of truth

The recommended production model: **store every secret in Infisical Cloud (free tier)** and launch
the app through the Infisical runner, which injects them as env vars at startup. The only
secrets-related values that stay on the box are the **bootstrap** (how to reach Infisical). Nothing
else — no API keys, no `ENCRYPTION_KEY`, no broker tokens — lives in `.env.local`.

Infisical Cloud is the managed SaaS (`infisical login` → their cloud, free tier: 5 identities / 3
projects / 3 envs / unlimited secrets). It's open-source, so you can self-host later with no app
change. GCP Secret Manager is also supported (`start:gcp`) but isn't strictly free past 6 secrets and
needs a service-account key file on the box.

## How it works
`npm run start:secrets` → `scripts/infisical-run.mjs` → `infisical run --env <INFISICAL_ENV> --path
<INFISICAL_PATH> [--projectId …] -- next start`. The Infisical CLI authenticates, pulls the project's
secrets, and injects them into the process env **before** Next boots. The runner also sets
`SECRETS_SOURCE=infisical`. (`gcp-secrets-run.mjs` is the GCP equivalent and sets `SECRETS_SOURCE=gcp`
only on a successful fetch.)

Precedence: injected secrets are in `process.env` before Next loads `.env.local`, and Next never
overrides an already-set var — so the manager always wins over any leftover `.env.local`.

## Enforcement (forcing the manager)
Set `REQUIRE_SECRETS_MANAGER=1` on the box. At startup (`instrumentation.ts` →
`assertSecretsManagerIfRequired`) the app **refuses to boot** unless `SECRETS_SOURCE` is set — i.e.
unless it was launched via `start:secrets` / `start:gcp`. This guarantees a credential can't silently
be served from a forgotten `.env.local`. Default off → no effect on local dev, tests, or CI.

## One-time migration from `.env.local` → Infisical (operator)
Secret values never pass through an agent — run this yourself:
```bash
brew install infisical/get-cli/infisical      # or: npm i -g @infisical/cli
infisical login                               # → Infisical Cloud
infisical init                                # link a project + env
# bulk-import your existing local secrets into the prod env:
infisical secrets set --env=prod --path=/ $(grep -vE '^\s*#|^\s*$' .env.local | xargs)
#   …or: Infisical dashboard → project → Secrets → "Import .env" → upload .env.local
```
Then create a **Machine Identity** (Project → Access Control), and on the box set the bootstrap:
```bash
export INFISICAL_TOKEN='<machine-identity token>'
export INFISICAL_PROJECT_ID='<project id>'
export INFISICAL_ENV='prod'
export REQUIRE_SECRETS_MANAGER=1
```
Switch the launch command, verify, then scrub `.env.local`:
- **PM2 (`trading.config.cjs` on the deploy box):** change the process to run `npm run start:secrets`
  instead of `next start` (or `infisical run … -- next start`). Then `pm2 restart trading --update-env`.
- Confirm the app boots and reads its keys (and that, with `REQUIRE_SECRETS_MANAGER=1`, a plain
  `next start` now refuses to boot).
- Reduce `.env.local` to just the bootstrap above (or nothing) and delete the rest.

## If some secrets are already in GCP
Export them to Infisical (run it yourself; values stay in your shell):
```bash
for s in $(gcloud secrets list --format='value(name)'); do
  v=$(gcloud secrets versions access latest --secret="$s")
  infisical secrets set "$s=$v" --env=prod --path=/
done
```
