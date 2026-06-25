# 2026-06-25 — Document `.env.local` source-of-truth (GCP Secret Manager)

## Summary

Documented, in one authoritative place, where `.env.local` lives across the
multi-worktree/multi-host setup and which copy is authoritative. Added a
**"Configuration & secrets (`.env.local`) — what's authoritative"** section to
`docs/deployment.md`. Net new doc content only — no code changed.

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
  "How it deploys (automated)").
- `STATUS.md` — new top entry for this docs change.
- `docs/rollouts/2026-06-25-env-local-source-of-truth-doc.md` — this note.

## Verification

Docs-only change (Markdown). The tsc/test/build trio is unaffected by Markdown
edits and was **not** re-run locally; the required `verify` CI check
(`tsc --noEmit` → `npm test` → `npm run build`) runs on the PR and gates merge.

- `git status` — only the three files above changed.
- Cross-checked every claim against source: `scripts/gcp-secrets-run.mjs`
  (env-var names, prefix-strip, overwrite, fallback), `package.json`
  (`dev:gcp`/`build:gcp`/`start:gcp`), `scripts/setup-agent-previews.sh:52-53`
  (one-time `.env.local` seed), `docs/deployment.md:32-33` (deploy preserves
  `.env.local`), `.gitignore:6-7` (ignore patterns).

## Follow-ups

- The GCP path is the *designated* source of truth but still needs
  `GCP_PROJECT_ID` + ADC configured on each box, and production auto-pull (PM2
  `trading` launched via `start:gcp`) wired into the host PM2 ecosystem
  (`~/apps/README.md`) before live deploys actually read from GCP. Tracked as a
  follow-up from the 2026-06-24 GCP-secrets rollout; not changed here.
- No `PLAN.md` change needed — this is documentation of existing behavior, not a
  scope/approach change.
