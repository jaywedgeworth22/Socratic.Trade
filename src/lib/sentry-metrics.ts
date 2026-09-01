/**
 * Sentry Application Metrics helpers for Socratic.Trade.
 *
 * Lightweight operational telemetry: counters, gauges, and distributions
 * for broker calls, scheduler ticks, RAG rejections, and embedding runs.
 * Safe no-op when Sentry is uninitialized or in test/CI environments.
 */

import * as Sentry from "@sentry/nextjs";

export function recordSchedulerTick(status: "ok" | "error" | "overrun", durationMs?: number): void {
  try {
    Sentry.metrics.count("scheduler.tick", 1, { attributes: { status } });
    if (durationMs !== undefined && Number.isFinite(durationMs)) {
      Sentry.metrics.distribution("scheduler.duration_ms", durationMs, { unit: "millisecond", attributes: { status } });
    }
  } catch {
    // Fail-soft: metrics should never crash execution
  }
}

export function recordBrokerCall(broker: string, endpoint: string, durationMs: number, status: "success" | "failure"): void {
  try {
    Sentry.metrics.count("broker.call", 1, { attributes: { broker, endpoint, status } });
    if (Number.isFinite(durationMs)) {
      Sentry.metrics.distribution("broker.call_duration_ms", durationMs, { unit: "millisecond", attributes: { broker, endpoint, status } });
    }
  } catch {
    // Fail-soft
  }
}

export function recordRagRejection(reason: string, provider?: string): void {
  try {
    Sentry.metrics.count("rag.rejected", 1, { attributes: { reason, provider: provider ?? "unknown" } });
  } catch {
    // Fail-soft
  }
}

export function recordEmbedFailure(provider: string, errorType: string): void {
  try {
    Sentry.metrics.count("embed.failed", 1, { attributes: { provider, error_type: errorType } });
  } catch {
    // Fail-soft
  }
}
