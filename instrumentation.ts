// Next.js instrumentation hook - runs once at server startup.
// See: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation

export async function onRequestError(...args: unknown[]) {
  if (!process.env.SENTRY_DSN) return;
  const Sentry = await import("@sentry/nextjs");
  Sentry.captureRequestError(...(args as Parameters<typeof Sentry.captureRequestError>));
}

export async function register() {
  if (typeof window !== "undefined") return;

  if (process.env.NEXT_RUNTIME === "edge") {
    if (process.env.SENTRY_DSN) {
      await import("./sentry.edge.config");
    }
    return;
  }

  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // next.config.mjs also sets this, but instrumentation is the guaranteed server-boot hook across
  // build modes/containers (the prod box moved to Coolify; the 2026-07-06 IPv6-blackhole fix — see
  // docs/rollouts/2026-07-06-api-health-timeouts.md — must hold there too). Run this FIRST, before
  // any other import below can trigger a network call. webpackIgnore: this file is also compiled for
  // the edge runtime above, and webpack has no "node:dns" handling for that target's bundle — the
  // comment keeps this a real runtime dynamic import instead of a build-time bundle attempt.
  const dns = await import(/* webpackIgnore: true */ "node:dns");
  dns.setDefaultResultOrder("ipv4first");

  // Fail fast if this deployment requires a secrets manager but wasn't launched through one
  // (REQUIRE_SECRETS_MANAGER set, but not started via start:secrets). Default off →
  // no effect on local dev / tests / CI. Runs before anything reads a credential.
  const { assertSecretsManagerIfRequired } = await import("./src/lib/secrets-source");
  assertSecretsManagerIfRequired();

  if (process.env.SENTRY_DSN) {
    await import("./sentry.server.config");
  }

  // Migrate the operator's env broker/LLM keys into the `local` primary user's stores, so key
  // resolution is uniformly per-user (no special `local` env branch). Idempotent.
  const { migrateLocalEnvCredentials } = await import("./src/lib/db");
  migrateLocalEnvCredentials();
  const { migrateLocalRobinhoodToken } = await import("./src/lib/mcp-oauth");
  migrateLocalRobinhoodToken();

  const { startObservability } = await import("./src/lib/observability");
  await startObservability();

  const { startScheduler } = await import("./src/lib/scheduler");
  startScheduler();

  // Reconstruct crash-lost outbound usage events from the durable LLM/RAG ledgers. No-op unless
  // the existing Usage Monitor base URL + ingest token are configured.
  const { startUsageMonitorReplay } = await import("./src/lib/usage-monitor-replay");
  startUsageMonitorReplay();

  // Outbound streaming workers (opt-in; no-op unless enabled + keyed).
  const { startStreams } = await import("./src/lib/streams");
  startStreams();
}
