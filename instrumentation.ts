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

  if (process.env.SENTRY_DSN) {
    await import("./sentry.server.config");
  }

  const { startObservability } = await import("./src/lib/observability");
  await startObservability();

  const { startScheduler } = await import("./src/lib/scheduler");
  startScheduler();

  // Outbound streaming workers (opt-in; no-op unless enabled + keyed).
  const { startStreams } = await import("./src/lib/streams");
  startStreams();
}
