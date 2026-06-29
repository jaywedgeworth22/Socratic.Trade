# Ops Observability, Secrets, and Backup

This app now has opt-in scaffolding for the seven selected tools:

- **Infisical**: use `npm run dev:secrets`, `npm run build:secrets`, or
  `npm run start:secrets` to execute the app under `infisical run`. Configure
  `INFISICAL_PROJECT_ID`, `INFISICAL_ENV`, `INFISICAL_PATH`, and a machine identity
  token in the host environment. Do not commit `.env.local`.
- **Gitleaks**: `npm run gitleaks` runs a local secret scan. The GitHub Actions
  Security workflow runs the pinned gitleaks action on the self-hosted runner
  and clears stale macOS installer temp files before invoking the action. The
  root `.gitleaksignore` baselines exact historical fingerprints reported by the
  scheduled full-history scan; do not add broad allowlists for live files.
- **Sentry**: add `SENTRY_DSN` for server/edge runtime errors. The app initializes
  Sentry from the Next.js instrumentation hook for runtime/request errors, but
  does not enable the Sentry build wrapper or browser SDK by default
  because that wrapper made Next's app-route manifest generation unstable in local
  verification. Browser Session Replay remains a follow-up.
- **Langfuse**: add `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY`. LLM calls are
  traced around Bull, Bear, Red Team, post-mortem, and strategy-tuning requests.
  The default `LANGFUSE_CAPTURE_IO=summary` captures model/schema/counts and
  proposal summaries, not raw prompt/account/portfolio text.
- **Dependabot**: `.github/dependabot.yml` watches npm dependencies. CI, smoke,
  and security workflows are active under `.github/workflows/`; see
  `STATUS.md` for the current runner policy.
- **Audit hardening**: npm overrides pin transitive Axios and PostCSS to patched
  releases, and Vitest is on the current major so its Vite dependency is patched.
- **Litestream**: continuous WAL replication of `data/app.db` to Cloudflare R2, run as
  a PM2 sidecar (`litestream`) via `scripts/run-litestream.sh` against `litestream.yml`.
  Restore with `scripts/litestream-restore.sh`. Full setup, monitoring, and DR steps are
  in `docs/litestream.md`.
- **Playwright**: `npm run test:e2e` runs a browser smoke test against a production
  `next build && next start` server on `PLAYWRIGHT_PORT`, or against
  `PLAYWRIGHT_BASE_URL` if one is supplied. If the Codex PM2 `next dev` preview is
  running in the same worktree, stop it before build/e2e checks and restart it
  afterward so both processes do not mutate `.next` at the same time.

## Local Setup

Install host CLIs:

```bash
infisical --version
gitleaks version
litestream version
```

Install Playwright's Chromium browser once per machine:

```bash
npx playwright install chromium
```

## Privacy Defaults

The telemetry path treats this as a financial application:

- Sentry `sendDefaultPii` is disabled.
- Sentry events run through `redactForTelemetry(...)`.
- Langfuse does not capture full prompts or portfolio/account details unless
  `LANGFUSE_CAPTURE_IO=full` is explicitly set, and even then it redacts common
  credential/account keys and long strings.
- Account numbers, API keys, tokens, cookies, webhook URLs, and encryption keys are
  redacted by key name.

## Production Notes

- **Infisical is the canonical store for production secrets** (see `docs/secrets.md`
  and `docs/deployment.md` → "Configuration & secrets"); deliver them with the
  `*:secrets` runner and enforce it with `REQUIRE_SECRETS_MANAGER=1` so the app
  refuses to boot off a local `.env.local`. The Litestream sidecar reads
  `LITESTREAM_*` from its own environment (not the app's runner), so run it under
  `infisical run` too. Don't rely on hand-edited `.env.local`.
- Litestream runs under PM2 (`litestream` sidecar) next to production `next start` — see
  `docs/litestream.md`. Periodically verify a restore to a scratch path
  (`scripts/litestream-restore.sh /tmp/app.db.restored`) before treating backups as ready.
- Browser Sentry, Session Replay, and source-map upload should be enabled in a
  follow-up only after revalidating the Sentry Next.js build wrapper against
  `npm run build`.
