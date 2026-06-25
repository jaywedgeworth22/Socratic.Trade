# 2026-06-25 — Document `.env.local` source-of-truth (GCP Secret Manager)

## Summary

Documented, in one authoritative place, where `.env.local` lives across the
multi-worktree/multi-host setup and which copy is authoritative. Added a
**"Configuration & secrets (`.env.local`) — what's authoritative"** section to
`docs/deployment.md`. Net new doc content only — no application code changed.
(A Codex review pass on PR #150 then refined the GCP fallback/refresh wording and
added a `PLAN.md` topology note — see Follow-ups.)

Key facts now written down:

- `.env.local` is git-ignored (`.gitignore`: `.env`, `.env*.local`); only the
  secret-free `.env.example` is tracked. Git is **not** the source of truth for
  secret *values*, and there is **no single canonical `.env.local` file** —
  each worktree/host has its own independent copy.
- **GCP Secret Manager is the authoritative upstream for secret values.** Every
  `.env.local` is a local cache/materialization of what lives in GCP; the
  canonical edit is updating a secret version in GCP.
- The `*:gcp` runner (`scripts/gcp-secrets-run.mjs` via `npm run
  dev:gcp`/`build:gcp`/`start:gcp`) injects GCP secrets at runtime — auth via
  `GCP_PROJECT_ID`/`GOOGLE_CLOUD_PROJECT` + ADC; scoping via `GCP_SECRET_NAMES`
  (explicit list) or `GCP_SECRETS_PREFIX` (prefix filter, prefix stripped to
  form the env name); `GCP_SECRETS_OVERWRITE=true` lets GCP override already-set
  env vars; graceful fallback to a plain run when `GCP_PROJECT_ID` is unset.
- Seed→diverge relationship across copies, captured as a table:
  - `~/Code/Agentic Trading/.env.local` = integration/dev **seed**;
    `scripts/setup-agent-previews.sh` copies it into a new agent worktree once,
    only if absent.
  - `~/apps/trading-<agent>/.env.local` = per-agent preview copy that diverges
    after the one-time seed.
  - `~/apps/trading-live/.env.local` = production, preserved across deploys
    (`git reset --hard FETCH_HEAD` only touches tracked files).
- Per-user API keys entered in the app are AES-256-GCM encrypted in the SQLite
  `user_api_keys` table (needs `ENCRYPTION_KEY`), not in `.env.local`;
  `.env.local` only holds operator/primary-user fallback keys.

## Why

The user asked which `.env.local` is authoritative given copies in
`~/Code/Agentic Trading` and several `~/apps/trading-*` folders, and designated
**GCP Secret Manager** as the source of truth. The answer was previously only
*implied* across `CLAUDE.md`/`AGENTS.md`, `docs/deployment.md`'s deploy section,
`scripts/setup-agent-previews.sh`, and
`docs/rollouts/2026-06-24-intrinio-tiingo-twelvedata-gcp-secrets.md` — never
stated in one place. This consolidates it next to the deploy mechanics that
already note `.env.local` is preserved on the live box.

## Files

- `docs/deployment.md` — new "Configuration & secrets (`.env.local`) — what's
  authoritative" section (inserted after the beta-hostname intro, before
  "How it deploys (automated)"). Post-review: the fallback bullet now steers to
  the plain scripts when GCP is unset and flags the `gcp-secrets-run.mjs`
  premature-exit bug; the seed row's refresh path points to GCP, not local edits.
- `PLAN.md` — dated secrets/config-topology note under "Current Status".
- `STATUS.md` — new top entry for this docs change.
- `docs/rollouts/2026-06-25-env-local-source-of-truth-doc.md` — this note.

## Verification

Ran the full trio in the cloud checkout (fresh clone — `node_modules` had to be
installed first):

```
npm ci            # exit 0
npm run build     # exit 0 — production build compiled
npx tsc --noEmit  # exit 0 — clean
npm test          # 1128/1129 passed (vitest run)
```

The single test failure is `test/cache-provenance.test.ts` ("user-keyed result
is NOT returned for a different userId") — the known, pre-existing,
date-sensitive cache-provenance flake (see `STATUS.md` and the 2026-06-24
rollouts), unrelated to this docs-only change. tsc and build are fully clean.

- `git status` — only Markdown/doc files changed (`docs/deployment.md`,
  `PLAN.md`, `STATUS.md`, this note).
- Cross-checked every claim against source: `scripts/gcp-secrets-run.mjs`
  (env-var mapping, prefix-strip, overwrite, and the no-project fallback's
  premature `process.exit(0)`), `package.json` (`dev:gcp`/`build:gcp`/`start:gcp`,
  `test` = `vitest run`), `scripts/setup-agent-previews.sh:52-53` (one-time
  `.env.local` seed), `docs/deployment.md` deploy section (deploy preserves
  `.env.local`), `.gitignore:6-7` (ignore patterns).

## Follow-ups

- **Bug — `scripts/gcp-secrets-run.mjs` no-project fallback exits early.** In the
  `if (!projectId)` branch it calls `runCommand(...)` then `process.exit(0)`
  synchronously, so the wrapper returns before the spawned child finishes (the
  non-fallback path correctly lets the child's `exit` handler own the exit). A
  chained `build:gcp && <deploy>` could proceed before `next build` completes.
  Fix in a separate code PR — e.g. guard the GCP block in `if (projectId)` and let
  the single tail `runCommand` own process exit. Documented here as an operator
  caveat (use the plain scripts when GCP is unconfigured). Surfaced by the Codex
  review on PR #150.
- The GCP path is the *designated* source of truth but still needs
  `GCP_PROJECT_ID` + ADC configured on each box, and production auto-pull (PM2
  `trading` launched via `start:gcp`) wired into the host PM2 ecosystem
  (`~/apps/README.md`) before live deploys actually read from GCP. Tracked from
  the 2026-06-24 GCP-secrets rollout; not changed here.
- `PLAN.md` updated with a dated secrets/config-topology note under "Current
  Status" (no phase scope, timeline, or approach changed).
