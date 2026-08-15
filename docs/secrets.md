# Secrets: source of truth

The recommended production model: **store every secret in Infisical Cloud (free tier)** and launch
the app through the Infisical runner, which injects them as env vars at startup. The only
secrets-related values that stay on the box are the **bootstrap** (how to reach Infisical). Nothing
else — no API keys, no `ENCRYPTION_KEY`, no broker tokens — lives in `.env.local`.

**LLM runtime keys are not Infisical secrets for this app.** `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `XAI_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY`,
`DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY`, `OPENROUTER_API_KEY`, and siblings belong
on Connections (`user_api_keys`). Do not put them back in Infisical ST `prod` `/`.
`scripts/infisical-secrets-safe.sh set` refuses those names. Deleted from Infisical
2026-08-15 (GEMINI/DEEPSEEK were the last remaining). `OPENROUTER_ADMIN_KEY` is an
agent admin credential, not an app chat key.

Infisical Cloud is the managed SaaS (`infisical login` → their cloud, free tier: 5 identities / 3
projects / 3 envs / unlimited secrets). It's open-source, so you can self-host later with no app
change. Infisical is the **only** secrets-manager path the app supports.

## How it works

`npm run start:secrets` starts `scripts/infisical-run.mjs`. In the normal non-watch path, the runner
authenticates, calls `infisical export` with a minimal CLI-only environment, merges the exported
values over the app's ambient environment, and starts the requested command through
`scripts/infisical-app-child.mjs`. Shared-overlay mode exports both projects the same way and lets the
app project win overlaps. `INFISICAL_WATCH=true` is the exception: the Infisical CLI owns its watch
loop and starts the same final wrapper after each injection. Every path sets
`SECRETS_SOURCE=infisical` before Next boots.

Exports use the CLI's JSON format rather than reparsing dotenv text, preserving multiline values,
quotes, backslashes, and whitespace exactly. Pinned Infisical CLI v0.43.98 emits a JSON array of
secret records; the runner copies only each record's validated string `key` and `value` and ignores
metadata. Non-array shapes, malformed or duplicate entries, invalid environment keys, and NUL bytes
fail with raw CLI output suppressed.

**Auth (per project):** the runner authenticates the machine identity with its **Client ID + Client
Secret** (universal auth, long-lived) — set `INFISICAL_CLIENT_ID` + `INFISICAL_CLIENT_SECRET` and it
exchanges them for a fresh access token on every launch via `infisical login --method=universal-auth
… --plain`, then passes that token only to the required `export` or watch operation (nothing expires
between deploys). A
pre-minted `INFISICAL_TOKEN` (a short-lived JWT) is still accepted as a fallback. **The Client Secret
is not the access token** — pasting a 64-char Client Secret into `INFISICAL_TOKEN` is the "malformed
token" 403; use the Client ID + Secret pair instead. Within one precedence source, a complete Client
ID + Secret pair wins over a stale token.

Precedence: exported/injected app secrets are in `process.env` before Next loads `.env.local`, and
Next does not override an already-defined variable. The final wrapper also installs empty masks for
every bootstrap credential name, so a stale `.env.local` or a credential-named Infisical secret
cannot restore a machine credential inside the app.

### Local machine-identity bootstrap

`scripts/infisical-run.mjs` must authenticate before Next starts, so it now resolves its own small
bootstrap set first. Precedence is explicit process environment, then `.env.local`, then the
owner-local `~/.secrets/global-api-keys` file. Only recognized Infisical bootstrap assignments are
parsed as inert dotenv data; quote state prevents key-looking lines inside unrelated multiline
values from being reinterpreted; indented/unrelated one-line data and provider/API keys are ignored
and never copied into `process.env` or child processes. The file is an assignment store, not a shell
program: multiline shell blocks and heredocs fail closed rather than being approximately parsed.

The generic runner names remain `INFISICAL_CLIENT_ID` + `INFISICAL_CLIENT_SECRET` for the app and
`INFISICAL_SHARED_CLIENT_ID` + `INFISICAL_SHARED_CLIENT_SECRET` for the shared overlay when supplied
through the process environment or `.env.local`. The shared machine file is narrower: it accepts only
`INFIISICAL_ST_*` (the owner-provided extra-I spelling) or corrected `INFISICAL_ST_*` for this app,
and `INFISICAL_CT_SHARED_*` for the shared project. It does not import generic app/shared names,
tokens, project IDs, runtime controls, provider keys, or cross-app credentials from that broad file.
The resolver normalizes the selected pair in memory only, never prints/copies a value, and refuses a
higher-precedence half-pair instead of combining fields across files.

The runner snapshots the selected identity, immediately removes every bootstrap credential from its
own long-lived `process.env`, and clears each auth object after its synchronous token mint/copy. The
CLI probe/login/export environment is a small OS/network allowlist plus only the credential needed by
that operation; ambient provider, GitHub, Slack, broker, and cross-app secrets never transit the
Infisical CLI. Raw login/export failure output is suppressed because a CLI could echo its
environment. Normal and overlay application children still receive their ambient app environment
directly from the trusted runner plus Infisical exports. Watch mode intentionally receives only the
small runtime allowlist plus Infisical-managed values, so credentials needed by a watched app must be
stored in Infisical rather than inherited from the shell. `INFISICAL_DOMAIN` is retained explicitly
for EU/self-hosted routing while remaining masked from the final app.

Before starting the Node final wrapper, `/usr/bin/env` removes `NODE_OPTIONS`, `BASH_ENV`, and `ENV`
so injected preload hooks cannot execute before bootstrap masking. The wrapper then restores the
intended `NODE_OPTIONS` only after installing every empty mask, preserves command argv without shell
evaluation, and forwards termination signals through the process chain. Normal export mode safely
restores the manager-winning `NODE_OPTIONS`; watch mode cannot inspect dynamic injected values before
the CLI spawns its child, so it deliberately discards an Infisical-injected `NODE_OPTIONS` and
restores only the pre-Infisical host value after masking.

The global path is fixed at `~/.secrets/global-api-keys`; an ambient `GLOBAL_API_KEYS_FILE` override
is ignored and scrubbed (tests can dependency-inject a temporary path directly into the resolver).
Before reading, the resolver checks `lstat`, opens with no-follow semantics, and verifies the opened
descriptor still identifies the same current-user-owned regular file. It rejects live/broken
symlinks, directories/devices/FIFOs, group/other permission bits, duplicate managed assignments, and
files over 1 MiB. Managed assignments are parsed with Node's dotenv parser as inert data; quotes,
command substitutions, backticks, semicolons, and other shell-looking text are never sourced or
evaluated.

The Socratic.Trade project defaults to `39d93bb7-76f9-498c-8b50-a7def52e072f`. The shared project
defaults to `18f563a3-9c88-454c-96eb-28fc9678f3ba` only when shared credentials are actually present
(or an operator explicitly sets `INFISICAL_SHARED_PROJECT_ID`), so app-only setups do not
accidentally enable an inaccessible overlay. A shared overlay without an explicit app identity/token
fails before either project is fetched. `scripts/cloud-setup.sh` runs a value-free bootstrap
check after seeding local defaults; a missing identity remains valid for keyless local UI work, but
any recognized incomplete pair fails closed before an Infisical CLI call.

### Primary-account Usage Monitor bridge (default off)

The optional writer in `src/lib/st-primary-bridge-writer.ts` is separate from
the app/bootstrap and shared-overlay identities above. It reads API-key rows
only for the compile-time primary user `LOCAL_USER` (`local`, the owner's
`mail@jays.services` account) and only the canonical `gemini` and `deepseek`
services. No request, manifest, environment variable, or route body can select
another user or add another provider.

Its destination is also fixed in code: Socratic.Trade project
`39d93bb7-76f9-498c-8b50-a7def52e072f`, environment `prod`, path
`/usage-monitor/st-primary/v1`. Enablement requires all three runtime values:

```bash
INFISICAL_ST_PRIMARY_WRITER_ENABLED=true
INFISICAL_ST_PRIMARY_WRITER_CLIENT_ID=...
INFISICAL_ST_PRIMARY_WRITER_CLIENT_SECRET=...
```

Use a dedicated project-managed identity: project membership role `no-access`,
then an identity-specific additional privilege scoped to exactly `prod` and
`/usage-monitor/st-primary/v1` with only secret `read`, `readValue`, `create`,
and `edit`. Do not grant delete, broader paths, project administration, or
identity administration. API Usage Monitor needs a separate identity with only
`read` and `readValue` on that same exact path. The writer identity pair is an
application feature credential (not a runner bootstrap alias) and may be stored
as managed production runtime secrets; it is never accepted from a browser or
from the broad local global-key bootstrap parser.

The writer publishes exactly `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, and a strict
`BRIDGE_MANIFEST_V1`. Active values are written and read-back-verified before
the manifest is committed last. The manifest carries only SHA-256
fingerprints, a monotonic sequence, and active/revoked status; it never carries
the key values. Revocation is a keyless manifest tombstone, not a remote secret
delete, matching the writer's intentionally delete-free privilege. Invalid,
partial, replayed, rolled-back, unexpected-path, or concurrently changed state
fails closed so the monitor retains its last-known-good complete generation.
The scheduler reconciles every five minutes while enabled, retries failures
after one minute, and key changes for the primary Gemini/DeepSeek rows queue an
immediate best-effort reconciliation.

## Enforcement (forcing the manager)
Set `REQUIRE_SECRETS_MANAGER=1` on the box. At startup (`instrumentation.ts` →
`assertSecretsManagerIfRequired`) the app **refuses to boot** unless `SECRETS_SOURCE` is set — i.e.
unless it was launched via `start:secrets`. This guarantees a credential can't silently
be served from a forgotten `.env.local`. Default off → no effect on local dev, tests, or CI.

## One-time migration from `.env.local` -> Infisical (legacy Mac rollback lane)
**Rollback-only TL;DR — run `scripts/infisical-prod-cutover.sh` on the Mac** (idempotent; needs your
machine-identity `INFISICAL_CLIENT_ID` + `INFISICAL_CLIENT_SECRET`, or run it interactively and it
prompts — Client Secret hidden). It automates steps 2–3 below: writes the bootstrap to
`~/.config/agentic-trading/deploy.env`, imports `.env.local` into Infisical, switches PM2 `trading`
to `start:secrets`, verifies the app boots, and (with `--scrub`) trims `.env.local`. Current Coolify
production does not use this script or the retired Mac deploy workflow; it injects the same Infisical
identity through `scripts/coolify-prod-start.sh` as documented in `docs/deployment.md`.

Secret values never pass through an agent — run the steps it automates yourself if you prefer:
```bash
brew install infisical/get-cli/infisical      # or: npm i -g @infisical/cli
infisical login                               # → Infisical Cloud
infisical init                                # link a project + env
# bulk-import your existing local secrets into the prod env:
infisical secrets set --env=prod --path=/ $(grep -vE '^\s*#|^\s*$' .env.local | xargs)
#   …or: Infisical dashboard → project → Secrets → "Import .env" → upload .env.local
```
Then create a **Machine Identity** (Project → Access Control) with the **Universal Auth** method and
copy its **Client ID** (a UUID — not secret) and a **Client Secret** (a 64-char string — secret,
never committed). App secrets live in the **`Socratic.Trade`** project (slug `socratic-trade`);
shared App-A/B (congress-trade) secrets live in **`shared-at-ct`**
(`18f563a3-9c88-454c-96eb-28fc9678f3ba`). To pull
both, give the cutover script a SECOND identity via `INFISICAL_SHARED_CLIENT_ID` +
`INFISICAL_SHARED_CLIENT_SECRET` (and optionally `INFISICAL_SHARED_PROJECT_ID`): the runner fetches
both projects with `infisical export` and merges them with the **app project winning** any overlapping
key (shared is the fallback). On the box set the bootstrap:
```bash
export INFISICAL_CLIENT_ID='<machine-identity Client ID>'          # a UUID; identifier, not a secret
export INFISICAL_CLIENT_SECRET='<machine-identity Client Secret>'  # the 64-char secret; never committed
export INFISICAL_PROJECT_ID='39d93bb7-76f9-498c-8b50-a7def52e072f' # Socratic.Trade (slug: socratic-trade)
export INFISICAL_ENV='prod'
export REQUIRE_SECRETS_MANAGER=1
```
The **Client Secret is not an access token** — the runner exchanges the Client ID + Secret for a
short-lived token at each launch, so nothing in `deploy.env` expires. (A pre-minted `INFISICAL_TOKEN`
is accepted as a fallback, but it expires — see the identity's Access Token TTL.)
Switch the launch command, verify, then scrub `.env.local`:
- **PM2 rollback only:** the cutover script re-creates `trading` to run `npm run start:secrets` with
  the bootstrap in `~/.config/agentic-trading/deploy.env`. There is no GitHub Actions deploy workflow;
  an operator must keep this process stopped unless the Coolify scheduler has been disabled and
  stopped first.
- Confirm the app boots and reads its keys (and that, with `REQUIRE_SECRETS_MANAGER=1`, a plain
  `next start` now refuses to boot).
- Reduce `.env.local` to just the bootstrap above (or nothing) and delete the rest.
