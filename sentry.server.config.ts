import * as Sentry from "@sentry/nextjs";
import { redactForTelemetry } from "./src/lib/telemetry-sanitize";

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.2"),
    enableLogs: true,
    sendDefaultPii: false,
    tracePropagationTargets: [
      "localhost",
      /^https:\/\/([\w-]+\.)?socratictrade\.com/,
      /^https:\/\/([\w-]+\.)?congress\.trade/,
      /^https:\/\/([\w-]+\.)?jays\.services/,
      /^https:\/\/usage\.jays\.services/,
    ],
    integrations: [
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
