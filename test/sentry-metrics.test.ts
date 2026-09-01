import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/nextjs";
import {
  logError,
  logWarn,
  recordBrokerCall,
  recordEmbedFailure,
  recordRagRejection,
  recordSchedulerTick
} from "../src/lib/sentry-metrics";

describe("sentry-metrics helpers", () => {
  beforeEach(() => {
    vi.stubEnv("SENTRY_DSN", "https://public@example.ingest.sentry.io/1");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("records scheduler.tick and scheduler.overrun together", async () => {
    const count = vi.spyOn(Sentry.metrics, "count").mockImplementation(() => undefined);
    const distribution = vi.spyOn(Sentry.metrics, "distribution").mockImplementation(() => undefined);
    recordSchedulerTick("overrun", 75_000);
    await vi.waitFor(() => {
      expect(count).toHaveBeenCalledWith("scheduler.tick", 1, { attributes: { status: "overrun" } });
    });
    expect(count).toHaveBeenCalledWith("scheduler.overrun", 1);
    expect(distribution).toHaveBeenCalledWith(
      "scheduler.duration_ms",
      75_000,
      expect.objectContaining({ unit: "millisecond" })
    );
  });

  it("records broker.call duration on failure", async () => {
    const count = vi.spyOn(Sentry.metrics, "count").mockImplementation(() => undefined);
    recordBrokerCall("kalshi", "GET /portfolio/positions", 12, "failure");
    await vi.waitFor(() => {
      expect(count).toHaveBeenCalledWith("broker.call", 1, {
        attributes: { broker: "kalshi", endpoint: "GET /portfolio/positions", status: "failure" }
      });
    });
  });

  it("records rag.rejected and embed.failed", async () => {
    const count = vi.spyOn(Sentry.metrics, "count").mockImplementation(() => undefined);
    recordRagRejection("malformed_query_embedding", "voyage");
    recordEmbedFailure("openrouter", "embed-api-failed");
    await vi.waitFor(() => {
      expect(count).toHaveBeenCalledWith("rag.rejected", 1, {
        attributes: { reason: "malformed_query_embedding", provider: "voyage" }
      });
    });
    expect(count).toHaveBeenCalledWith("embed.failed", 1, {
      attributes: { provider: "openrouter", error_type: "embed-api-failed" }
    });
  });

  it("emits sparse structured logs without throwing", async () => {
    const warn = vi.spyOn(Sentry.logger, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(Sentry.logger, "error").mockImplementation(() => undefined);
    logWarn("rag.rejected", { provider: "voyage", reason: "malformed" });
    logError("broker.call", { broker: "alpaca", endpoint: "mcp:get_orders" });
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith("rag.rejected", {
        provider: "voyage",
        reason: "malformed"
      });
    });
    expect(error).toHaveBeenCalledWith("broker.call", {
      broker: "alpaca",
      endpoint: "mcp:get_orders"
    });
  });

  it("does not throw when the SDK methods throw", async () => {
    vi.spyOn(Sentry.metrics, "count").mockImplementation(() => {
      throw new Error("metrics down");
    });
    expect(() => recordSchedulerTick("ok", 10)).not.toThrow();
    await Promise.resolve();
  });
});
