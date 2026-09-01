// Browser / client runtime Sentry init. Mirrors sentry.server.config.ts:
// env-gated (off unless NEXT_PUBLIC_SENTRY_DSN is set), PII disabled, and every
// event run through redactForTelemetry — this is a financial app, so nothing
// user-facing (account numbers, keys, tokens) may leave the browser.
import * as Sentry from "@sentry/nextjs";
import { redactForTelemetry } from "./src/lib/telemetry-sanitize";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  // Session Replay records DOM/network around errors. With our sponsored tier,
  // replay is enabled by default (100% on error, 10% baseline session sampling)
  // while strictly masking all text and blocking all media so portfolio/account
  // values are never captured.
  const replayDisabled = process.env.NEXT_PUBLIC_SENTRY_REPLAY_ENABLED === "false";
  const replaySessionSampleRate = Number(
    process.env.NEXT_PUBLIC_SENTRY_REPLAY_SESSION_SAMPLE_RATE ?? "0.1"
  );
  const replayErrorSampleRate = Number(
    process.env.NEXT_PUBLIC_SENTRY_REPLAY_ERROR_SAMPLE_RATE ?? "1.0"
  );

  Sentry.init({
    dsn,
    environment:
      process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || process.env.NODE_ENV,
    tracesSampleRate: Number(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? "0.2"),
    sendDefaultPii: false,
    replaysSessionSampleRate: !replayDisabled ? replaySessionSampleRate : 0,
    replaysOnErrorSampleRate: !replayDisabled ? replayErrorSampleRate : 0,
    integrations: !replayDisabled
      ? [Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true })]
      : [],
    beforeSend(event) {
      return redactForTelemetry(event) as typeof event;
    }
  });
}

const rumApplicationId =
  process.env.NEXT_PUBLIC_DD_APPLICATION_ID ||
  process.env.NEXT_PUBLIC_DD_RUM_APPLICATION_ID;
const rumClientToken =
  process.env.NEXT_PUBLIC_DD_CLIENT_TOKEN ||
  process.env.NEXT_PUBLIC_DD_RUM_CLIENT_TOKEN;
if (rumApplicationId && rumClientToken) {
  void import("./src/lib/datadog-env").then(({ resolvePublicRumConfig }) =>
    import("./src/lib/datadog-rum").then(({ startDatadogRum }) => startDatadogRum(resolvePublicRumConfig()))
  );
}

// App Router navigation instrumentation. Safe to export unconditionally — it is a
// no-op when Sentry was not initialized above.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
