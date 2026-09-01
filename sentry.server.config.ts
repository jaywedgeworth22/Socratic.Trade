import { createRequire } from "node:module";
import * as Sentry from "@sentry/nextjs";
import { redactForTelemetry } from "./src/lib/telemetry-sanitize";

/** Continuous Node profiling. Native addon — missing binary must not take down Sentry.init. */
function maybeNodeProfilingIntegration(): ReturnType<typeof Sentry.nodeRuntimeMetricsIntegration> | undefined {
  try {
    const req = createRequire(import.meta.url);
    const mod = req("@sentry/profiling-node") as {
      nodeProfilingIntegration?: () => ReturnType<typeof Sentry.nodeRuntimeMetricsIntegration>;
    };
    return typeof mod.nodeProfilingIntegration === "function" ? mod.nodeProfilingIntegration() : undefined;
  } catch {
    return undefined;
  }
}

if (process.env.SENTRY_DSN) {
  const profiling = maybeNodeProfilingIntegration();
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.2"),
    enableLogs: true,
    sendDefaultPii: false,
    // Continuous profiling on the Node server only (not browser UI profiling).
    profileSessionSampleRate: Number(process.env.SENTRY_PROFILE_SESSION_SAMPLE_RATE ?? "1"),
    profileLifecycle: "trace",
    tracePropagationTargets: [
      "localhost",
      /^https:\/\/([\w-]+\.)?socratictrade\.com/,
      /^https:\/\/([\w-]+\.)?congress\.trade/,
      /^https:\/\/([\w-]+\.)?jays\.services/,
      /^https:\/\/usage\.jays\.services/,
    ],
    integrations: [
      ...(profiling ? [profiling] : []),
      Sentry.nodeRuntimeMetricsIntegration(),
      Sentry.openAIIntegration(),
      Sentry.anthropicAIIntegration(),
      Sentry.googleGenAIIntegration(),
      Sentry.vercelAIIntegration(),
      Sentry.langChainIntegration(),
    ],
    beforeSend(event) {
      return redactForTelemetry(event) as typeof event;
    }
  });
}
