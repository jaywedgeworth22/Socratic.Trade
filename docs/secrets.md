# Secrets: source of truth

The recommended production model: **store every secret in Infisical Cloud (free tier)** and launch
the app through the Infisical runner, which injects them as env vars at startup. The only
secrets-related values that stay on the box are the **bootstrap** (how to reach Infisical). Nothing
else — no API keys, no `ENCRYPTION_KEY`, no broker tokens — lives in `.env.local`.

Infisical Cloud is the managed SaaS (`infisical login` → their cloud, free tier: 5 identities / 3
projects / 3 envs / unlimited secrets). It's open-source, so you can self-host later with no app
change. Infisical is the **only** secrets-manager path the app supports.

## How it works
`npm run start:secrets` → `scripts/infisical-run.mjs` → `infisical run --env <INFISICAL_ENV> --path
<INFISICAL_PATH> [--projectId …] -- next start`. The Infisical CLI authenticates, pulls the project's
secrets, and injects them into the process env **before** Next boots. The runner also sets
`SECRETS_SOURCE=infisical`.

Precedence: injected secrets are in `process.env` before Next loads `.env.local`, and Next never
overrides an already-set var — so the manager always wins over any leftover `.env.local`.

## Enforcement (forcing the manager)
Set `REQUIRE_SECRETS_MANAGER=1` on the box. At startup (`instrumentation.ts` →
`assertSecretsManagerIfRequired`) the app **refuses to boot** unless `SECRETS_SOURCE` is set — i.e.
unless it was launched via `start:secrets`. This guarantees a credential can't silently
be served from a forgotten `.env.local`. Default off → no effect on local dev, tests, or CI.

## One-time migration from `.env.local` → Infisical (operator)
**TL;DR — run `scripts/infisical-prod-cutover.sh` on the box** (idempotent; needs your
machine-identity `INFISICAL_TOKEN`). It automates steps 2–3 below: writes the bootstrap to
`~/.config/agentic-trading/deploy.env`, imports `.env.local` into Infisical, switches PM2 `trading`
to `start:secrets`, verifies the app boots, and (with `--scrub`) trims `.env.local`. Afterward
`deploy.yml` sources that bootstrap and builds via Infisical automatically (it falls back to a plain
build/restart while the file is absent, so nothing breaks pre-cutover).

Secret values never pass through an agent — run the steps it automates yourself if you prefer:
```bash
brew install infisical/get-cli/infisical      # or: npm i -g @infisical/cli
infisical login                               # → Infisical Cloud
infisical init                                # link a project + env
# bulk-import your existing local secrets into the prod env:
infisical secrets set --env=prod --path=/ $(grep -vE '^\s*#|^\s*$' .env.local | xargs)
#   …or: Infisical dashboard → project → Secrets → "Import .env" → upload .env.local
```
Then create a **Machine Identity** (Project → Access Control) and on the box set the bootstrap. App
secrets live in the **`agentic-trading`** project; shared App-A/B (congress-trade) secrets live in
**`shared-at-ct`** (`18f563a3-9c88-454c-96eb-28fc9678f3ba`) — reference them into the app project
(Infisical cross-project references) or pull them in a second pass.
```bash
export INFISICAL_TOKEN='<machine-identity universal-auth token>'   # the client SECRET, never committed
export INFISICAL_PROJECT_ID='39d93bb7-76f9-498c-8b50-a7def52e072f' # agentic-trading (agentic-trading-s-xn-n)
export INFISICAL_ENV='prod'
export REQUIRE_SECRETS_MANAGER=1
```
Switch the launch command, verify, then scrub `.env.local`:
- **PM2:** the cutover script re-creates the `trading` process to run `npm run start:secrets`; with
  the bootstrap in `~/.config/agentic-trading/deploy.env`, `deploy.yml` keeps it on that path (and
  refreshes the token via `pm2 restart --update-env`) on every deploy.
- Confirm the app boots and reads its keys (and that, with `REQUIRE_SECRETS_MANAGER=1`, a plain
  `next start` now refuses to boot).
- Reduce `.env.local` to just the bootstrap above (or nothing) and delete the rest.
