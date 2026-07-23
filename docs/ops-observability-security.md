# Ops Observability, Secrets, and Backup

This app now has opt-in scaffolding for the seven selected tools:

- **Infisical**: use `npm run dev:secrets`, `npm run build:secrets`, or
  `npm run start:secrets`. The runner normally exports secrets through a minimal CLI
  environment and starts the app directly; `INFISICAL_WATCH=true` uses `infisical run
  --watch` plus the final credential-masking wrapper. Configure `INFISICAL_PROJECT_ID`,
  `INFISICAL_ENV`, `INFISICAL_PATH`, and a machine identity pair/token. Do not commit
  `.env.local`.
- **Gitleaks**: `npm run gitleaks` runs a local secret scan. The GitHub Actions
  Security workflow runs the pinned gitleaks action on the self-hosted runner
  and clears stale macOS installer temp files before invoking the action.
- **Sentry**: full Next.js coverage across all three runtimes, env-gated and off by
  default. Set `SENTRY_DSN` for the server + edge runtimes
  (`sentry.server.config.ts` / `sentry.edge.config.ts`, loaded via the instrumentation
  hook) and `NEXT_PUBLIC_SENTRY_DSN` for the browser (`instrumentation-client.ts`).
  `next.config.mjs` is wrapped with `withSentryConfig` (org `jays-services`, project
  `socratic-trade`); set the build-time secret `SENTRY_AUTH_TOKEN` to upload source maps
  for de-minified production stack traces. `app/global-error.tsx` reports root-layout
  render errors. The previous build-wrapper instability did not reproduce on
  `@sentry/nextjs@10` + Next 16. Browser Session Replay is opt-in
  (`NEXT_PUBLIC_SENTRY_REPLAY_ENABLED=true`) and masks all text + blocks all media when on.
  RAG provider failures, Pinecone index/metric checks, ingest budget trips, Pinecone Write
  Unit budget trips, malformed embedding rejections, and retrieval degradations are captured
  as warning/error events tagged `component=rag`, `rag.provider`, `rag.operation`, and
  `rag.key_source`; they stay no-op unless `SENTRY_DSN` is set.
- **Sentry Crons scheduler heartbeat**: a dead/hung scheduler still returns 200 from
  `/api/health`, so the scheduler tick can additionally report an "ok" check-in to the
  Sentry Crons monitor `scheduler-tick` every 60s tick (`sendSentrySchedulerCheckIn` in
  `src/lib/scheduler.ts`); Sentry alerts when check-ins stop. Opt-in — requires BOTH
  `SENTRY_DSN` and `SENTRY_CRONS_ENABLED=1` — placed after the single-leader gate so idle
  followers can't mask a dead leader, and fully try/catch-wrapped so monitoring can never
  break trading. The monitor is auto-created via the upsert config on first check-in
  (interval 1 minute, 5-minute checkin margin). Inertness is asserted by
  `test/sentry-inert.test.ts`.
- **Scheduler and strategy ownership leases**: scheduler single-leader coordination is ON by
  default, including when `SCHEDULER_SINGLE_LEADER` is unset or empty; only an explicit
  `false`/`off`/`0`/`no` disables it. Each strategy/approval invocation owns its account-scoped
  lease with a unique token. A 60-second heartbeat renews the five-minute strategy lease; refused
  or thrown renewals are caught and become sticky ownership loss, and the code synchronously
  re-proves ownership before it writes a placing intent or calls the broker.
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

- Prefer Infisical for all production secrets instead of hand-edited `.env.local`.
- Litestream runs under PM2 (`litestream` sidecar) next to production `next start` — see
  `docs/litestream.md`. Periodically verify a restore to a scratch path
  (`scripts/litestream-restore.sh /tmp/app.db.restored`) before treating backups as ready.
- Browser Sentry, Session Replay, and source-map upload should be enabled in a
  follow-up only after revalidating the Sentry Next.js build wrapper against
  `npm run build`.
