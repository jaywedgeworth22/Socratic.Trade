import * as Sentry from "@sentry/nextjs";
import { redactForTelemetry, redactTransactionEvent, sanitizeTelemetryUrl } from "./src/lib/telemetry-sanitize";

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.2"),
    sendDefaultPii: false,
    beforeSend(event) {
      if (event.request?.url) {
        event.request.url = sanitizeTelemetryUrl(event.request.url);
      }
      return redactForTelemetry(event) as typeof event;
    },
    beforeSendTransaction(event) {
      if (event.request?.url) {
        event.request.url = sanitizeTelemetryUrl(event.request.url);
      }
      return redactTransactionEvent(event) as typeof event;
    }
  });
}
