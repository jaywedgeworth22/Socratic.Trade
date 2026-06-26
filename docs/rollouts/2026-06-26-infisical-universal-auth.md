# 2026-06-26 — Infisical universal auth (Client ID + Client Secret), end the token confusion

## Summary

The operator could not complete the production cutover. Two errors, same root cause:

1. **403 "The provided access token is malformed"** — `INFISICAL_TOKEN` was set to a 64-char
   machine-identity **Client Secret**. That env var expects a short-lived **access token** (a JWT),
   not the Client Secret. Our own `docs/secrets.md` mislabeled it (`INFISICAL_TOKEN='…' # the client
   SECRET`), which led directly to the wrong value being pasted.
2. **401 "Invalid credentials"** when minting a token via `infisical login` — the shared identity's
   Client ID was paired with the wrong Client Secret (two projects, easy to swap), and the box's
   `set -u` shared-verify block then crashed with `SHARED_PROJECT_ID: unbound variable`.

Fix: make the machine-identity **Client ID + Client Secret** (Universal Auth — long-lived) the primary
credential across the runner, the cutover script, deploy, and docs. The CLI/runner exchange them for a
fresh access token on every launch, so nothing in `deploy.env` expires and operators never handle raw
tokens.

## Why

- A Client Secret ≠ an access token. Persisting a minted token is also wrong: the identity's Access
  Token TTL is finite (the operator's is 2,592,000s = 30 days), so a stored token would silently die.
  Storing the **Client ID + Client Secret** and minting per-launch removes the whole failure class.
- The `set -u` crash and the silent "malformed token" 403 both needed to become clear, actionable
  messages.

## What changed

- **`scripts/infisical-run.mjs`** — per-project auth resolves Client ID + Client Secret first
  (`INFISICAL_CLIENT_ID`/`INFISICAL_CLIENT_SECRET`, and `INFISICAL_SHARED_CLIENT_ID`/`…_SECRET`) and
  **exchanges them for a short-lived access token** via `infisical login --method=universal-auth …
  --plain`, then passes that token to the single-project `infisical run` path and each `infisical
  export` in the app+shared overlay. (Initially this mapped the client creds onto the CLI's
  `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID`/`…_CLIENT_SECRET` env vars; Codex review #177 P1 flagged that
  `run`/`export` aren't guaranteed to auto-auth from those — the documented machine-identity flow is
  to mint a token — so the runner now mints explicitly.) App and shared identities stay distinct
  (shared falls back to the app identity only when it has no creds of its own); the Client Secret is
  never leaked into the spawned app process. A pre-minted `INFISICAL_TOKEN` still works as a fallback.
- **`scripts/infisical-prod-cutover.sh`** — accepts the Client ID/Secret (env → prior `deploy.env` →
  interactive prompt: Client ID visible, Client Secret hidden); mints a token the same way for its own
  verify/import calls while persisting the **long-lived** creds to `deploy.env`; **detects a 64-hex
  value in a token field and dies with the explanation** (app + shared — per Codex review #177 P2, an
  explicitly-set-but-malformed `INFISICAL_SHARED_TOKEN` now fails closed instead of silently
  restarting prod app-only); and hardens the shared overlay so it cleanly skips when not requested (no
  `set -u` unbound-variable crash).
- **`.github/workflows/deploy.yml`** — the `build:secrets` gate fires on Client ID + Client Secret (or
  a token), so a client-creds box still builds with secrets. The bootstrap is sourced in **subshells
  scoped to the build and restart steps only — never around `npm ci`**, so the long-lived Client
  Secret is not exposed to dependency install/lifecycle scripts (Codex review #177 round 2).
- **`.env.example`, `docs/secrets.md`, `docs/deployment.md`** — corrected the token-vs-Client-Secret
  conflation; documented `INFISICAL_CLIENT_ID`/`INFISICAL_CLIENT_SECRET` (+ shared) as the primary
  bootstrap.

### Security hardening (Codex review #177 rounds 2–5)

Round 2:
- **Mint via env, not argv:** both `mintToken` (runner) and `mint_token` (cutover) now pass the
  Client ID/Secret to `infisical login` through `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID`/`…_CLIENT_SECRET`
  in the child env instead of `--client-secret=` on the command line, so the long-lived secret never
  appears in `ps`/`/proc/<pid>/cmdline`.
- **Fail closed on a partial shared identity (cutover):** setting only one of
  `INFISICAL_SHARED_CLIENT_ID`/`INFISICAL_SHARED_CLIENT_SECRET` now dies (mirroring the app path)
  rather than silently restarting prod without the shared overlay.
- **Scope the bootstrap away from `npm ci`** (deploy.yml subshells, above).

Round 3:
- **Sanitize the `infisical export` subprocess env (runner):** `fetchProject` now builds its env via
  `childEnv` (which strips every client secret / universal-auth var), so each overlay export
  authenticates with only the short-lived token — no client secrets in the export child's env.
- **Fail closed on partial runner credentials:** `infisical-run.mjs` validates the app pair (always)
  and the shared pair (when the overlay is on) up front — exactly one of id/secret → exit 2, instead
  of silently falling back to a stale token or a cached CLI login while still setting
  `SECRETS_SOURCE=infisical`.
- **Fail the deploy on a present-but-unusable bootstrap:** when `deploy.env` exists (the cutover
  signal, with `REQUIRE_SECRETS_MANAGER=1`) but the `infisical` CLI is missing or no complete
  credential is present, `deploy.yml` now errors instead of doing a silent plain build that would then
  restart a `start:secrets` service that can't boot.

Round 4:
- **Cutover: fail closed on a lone app Client Secret.** The app validation previously caught only
  `CLIENT_ID`-without-secret; a lone `INFISICAL_CLIENT_SECRET` (no id) plus a stale `INFISICAL_TOKEN`
  in `deploy.env` would fall back to the expiring token and persist *that*. The app path now does the
  same full XOR check as the runner/shared paths — either half without the other dies.

Round 5:
- **Sanitize the cutover's own `infisical` children.** When invoked the documented way
  (`INFISICAL_CLIENT_SECRET=… bash …` / exported), `infisical_app`/`infisical_shared` set the token but
  the exported long-lived Client Secret was still inherited by every `infisical secrets`/`secrets set`
  verify/import child. New `infisical_tok` helper runs them via `env -u …` so they authenticate with
  only the short-lived token — same scoping as the runner's `childEnv`. This completes secret-scoping
  across every child-process surface (runner app launch, runner export, cutover verify/import).

## Files

- `scripts/infisical-run.mjs`
- `scripts/infisical-prod-cutover.sh`
- `.github/workflows/deploy.yml`
- `.env.example`
- `docs/secrets.md`, `docs/deployment.md`
- `STATUS.md`, `PLAN.md`, this rollout note.

## Verification

- `node --check scripts/infisical-run.mjs` ✓; `bash -n scripts/infisical-prod-cutover.sh` ✓.
- **Round-2 hardening, re-proven with shims:** runner mints via env (login `argv` contains no
  `--client-secret`, creds arrive as `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID/SECRET`), the minted token
  flows to run/export, and no Client Secret leaks into the spawned process; cutover fails closed on a
  partial shared identity and on a Client-Secret-as-token, happy path still writes long-lived creds to
  `deploy.env`; a deploy.yml simulation confirms `npm ci` sees **no** Client Secret while
  `build:secrets` + `pm2 restart --update-env` do. `tsc` clean.
- **Fake `infisical` shim** (real CLI absent in the sandbox): single-project client-creds → CLI gets
  `UA_CLIENT_ID/SECRET`, no `INFISICAL_TOKEN`, `SECRETS_SOURCE=infisical`; token-only → token passed
  through; stale token + client creds → universal auth wins and token is dropped; app+shared overlay →
  each `export` runs under its own identity, **app wins the overlapping key**, app-only/shared-only
  keys both present, exit codes propagate; shared-without-creds → borrows the app identity. (One test
  assertion was written against multi-line stdout and mis-flagged; the captured output shows
  `FOO=app_foo` + `app wins 1 overlap(s)`, i.e. correct.)
- Trio: `npx tsc --noEmit` ✓ · `npm test` **1250/1250** ✓ · `npm run build` ✓ (reverted the
  `next-env.d.ts` / `tsconfig.json` build churn).

## Operator notes / follow-ups

- **In-flight cutover unblock:** the app verify already passes; the crash was the shared block running
  because the shared **Client Secret** was exported as `INFISICAL_SHARED_TOKEN`. `unset
  INFISICAL_SHARED_TOKEN` and re-run to complete the app-only cutover now; after this PR deploys, the
  hardened script catches that case itself.
- **Auth going forward:** set `INFISICAL_CLIENT_ID` + `INFISICAL_CLIENT_SECRET` (app) and, for the
  overlay, `INFISICAL_SHARED_CLIENT_ID` + `INFISICAL_SHARED_CLIENT_SECRET` (shared-at-ct). Pair each
  Client Secret with **its own** identity's Client ID. The runner mints tokens itself.
- **Security:** the Client Secrets pasted in chat earlier are compromised — rotate both in the
  Infisical dashboard (each identity → Universal Auth → roll the Client Secret).
- The live Infisical CLI couldn't be exercised here; the universal-auth env-var mechanism is per
  Infisical's CLI docs. Operator should confirm on the box (the hardened script fails loudly if auth
  is wrong, before changing anything).
