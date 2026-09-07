// Regression coverage for the scheduler's error-classification / log-dedup observability added
// alongside the Tradier order-capability probe fix. Production evidence (litestream-runtime.log,
// 2026-08-29..2026-09-07): a single restricted/misbehaving Tradier account generated 1,364
// identical "[scheduler] Tradier order capability probe failed" lines because the health-gate
// skip warn re-logged the SAME cause on every 60s tick. These tests exercise the pure
// log-dedup / lane-failure-classification helpers directly (no DB, no broker) rather than
// driving a full tick — the helpers have no side effects beyond console/Sentry logging.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentryMetricsMock = vi.hoisted(() => ({
  logWarn: vi.fn(),
  logError: vi.fn()
}));

vi.mock("../src/lib/sentry-metrics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/sentry-metrics")>();
  return { ...actual, logWarn: sentryMetricsMock.logWarn, logError: sentryMetricsMock.logError };
});

beforeEach(() => {
  sentryMetricsMock.logWarn.mockReset();
  sentryMetricsMock.logError.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logHealthGateSkip / clearHealthGateSkip", () => {
  it("logs once on the first occurrence of a cause and emits an account_skip_started structured event", async () => {
    const { logHealthGateSkip, _resetSchedulerObservabilityStateForTest } = await import("../src/lib/scheduler");
    _resetSchedulerObservabilityStateForTest();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    logHealthGateSkip("local:acct-1", "Tradier order capability probe failed: boom", false);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("Tradier order capability probe failed: boom");
    expect(sentryMetricsMock.logWarn).toHaveBeenCalledWith(
      "scheduler.health_gate",
      expect.objectContaining({ event: "account_skip_started", key: "local:acct-1" })
    );
  });

  it("does NOT re-log an unchanged cause on subsequent ticks (the 1,364-line production bug)", async () => {
    const { logHealthGateSkip, _resetSchedulerObservabilityStateForTest } = await import("../src/lib/scheduler");
    _resetSchedulerObservabilityStateForTest();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const reason = "Tradier order capability probe failed: boom";
    for (let i = 0; i < 10; i++) {
      logHealthGateSkip("local:acct-1", reason, false);
    }

    // Only the first occurrence logs — the other 9 identical-cause ticks stay silent (well under
    // the 30-tick heartbeat threshold), directly addressing the 1,364-line production volume.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(sentryMetricsMock.logWarn).toHaveBeenCalledTimes(1);
  });

  it("re-logs immediately when the cause (reason or halt state) changes", async () => {
    const { logHealthGateSkip, _resetSchedulerObservabilityStateForTest } = await import("../src/lib/scheduler");
    _resetSchedulerObservabilityStateForTest();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    logHealthGateSkip("local:acct-1", "Tradier order capability probe failed: boom", false);
    logHealthGateSkip("local:acct-1", "Tradier order capability probe failed: boom", false);
    logHealthGateSkip("local:acct-1", "Account equity too low", false); // new cause
    logHealthGateSkip("local:acct-1", "Account equity too low", true); // same reason, now halted

    expect(warnSpy).toHaveBeenCalledTimes(3);
  });

  it("emits a low-rate heartbeat instead of staying silent forever on a sustained cause", async () => {
    const { logHealthGateSkip, HEALTH_SKIP_HEARTBEAT_EVERY, _resetSchedulerObservabilityStateForTest } = await import(
      "../src/lib/scheduler"
    );
    _resetSchedulerObservabilityStateForTest();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const reason = "Tradier order capability probe failed: boom";
    for (let i = 0; i < HEALTH_SKIP_HEARTBEAT_EVERY; i++) {
      logHealthGateSkip("local:acct-1", reason, false);
    }

    // First occurrence + one heartbeat at the threshold.
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls[1]?.[0]).toContain("still unhealthy");
  });

  it("clearHealthGateSkip announces recovery only when the account was previously unhealthy", async () => {
    const { logHealthGateSkip, clearHealthGateSkip, _resetSchedulerObservabilityStateForTest } = await import(
      "../src/lib/scheduler"
    );
    _resetSchedulerObservabilityStateForTest();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    clearHealthGateSkip("local:never-unhealthy"); // no-op, was never logged
    expect(sentryMetricsMock.logWarn).not.toHaveBeenCalled();

    logHealthGateSkip("local:acct-1", "boom", false);
    clearHealthGateSkip("local:acct-1");
    expect(sentryMetricsMock.logWarn).toHaveBeenLastCalledWith(
      "scheduler.health_gate",
      expect.objectContaining({ event: "account_skip_recovered", key: "local:acct-1" })
    );

    // A second clear on the same (already-cleared) key must not double-announce.
    sentryMetricsMock.logWarn.mockClear();
    clearHealthGateSkip("local:acct-1");
    expect(sentryMetricsMock.logWarn).not.toHaveBeenCalled();
  });
});

describe("classifyLaneFailure", () => {
  it("classifies an AbortError / timeout distinctly from a dead-socket transient network error", async () => {
    const { classifyLaneFailure } = await import("../src/lib/scheduler");
    expect(classifyLaneFailure(new Error("runSyntheticStopMonitor timeout"))).toBe("timeout");
    const abort = new Error("This operation was aborted");
    abort.name = "AbortError";
    expect(classifyLaneFailure(abort)).toBe("timeout");
    expect(classifyLaneFailure(new TypeError("fetch failed"))).toBe("transient_network");
    const socketErr = new Error("other side closed");
    socketErr.name = "SocketError";
    expect(classifyLaneFailure(socketErr)).toBe("transient_network");
    expect(classifyLaneFailure(new Error("something unrelated exploded"))).toBe("other");
  });
});

describe("recordLaneFailure / recordLaneRecovery", () => {
  it("logs every occurrence but only escalates to lane_degraded once a streak crosses the threshold", async () => {
    const { recordLaneFailure, LANE_DEGRADED_STREAK_THRESHOLD, _resetSchedulerObservabilityStateForTest } =
      await import("../src/lib/scheduler");
    _resetSchedulerObservabilityStateForTest();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    for (let i = 0; i < LANE_DEGRADED_STREAK_THRESHOLD; i++) {
      recordLaneFailure("synthetic-stop monitor", "local:acct-1", new TypeError("fetch failed"));
    }

    expect(errorSpy).toHaveBeenCalledTimes(LANE_DEGRADED_STREAK_THRESHOLD);
    expect(sentryMetricsMock.logError).toHaveBeenCalledTimes(1);
    expect(sentryMetricsMock.logError).toHaveBeenCalledWith(
      "scheduler.lane",
      expect.objectContaining({
        event: "lane_degraded",
        lane: "synthetic-stop monitor",
        key: "local:acct-1",
        category: "transient_network",
        streak: LANE_DEGRADED_STREAK_THRESHOLD
      })
    );

    // A further failure of the SAME category must not re-announce an already-degraded lane.
    recordLaneFailure("synthetic-stop monitor", "local:acct-1", new TypeError("fetch failed"));
    expect(sentryMetricsMock.logError).toHaveBeenCalledTimes(1);
  });

  it("a different failure category resets the streak instead of accumulating across categories", async () => {
    const { recordLaneFailure, LANE_DEGRADED_STREAK_THRESHOLD, _resetSchedulerObservabilityStateForTest } =
      await import("../src/lib/scheduler");
    _resetSchedulerObservabilityStateForTest();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    for (let i = 0; i < LANE_DEGRADED_STREAK_THRESHOLD - 1; i++) {
      recordLaneFailure("stale-limit-order handling", "local:acct-2", new TypeError("fetch failed"));
    }
    // Category flips to "timeout" — streak restarts at 1, must not itself trip the threshold.
    recordLaneFailure("stale-limit-order handling", "local:acct-2", new Error("stale-limit-scan broker timeout"));

    expect(sentryMetricsMock.logError).not.toHaveBeenCalled();
  });

  it("recordLaneRecovery announces recovery only after a lane had gone degraded", async () => {
    const { recordLaneFailure, recordLaneRecovery, LANE_DEGRADED_STREAK_THRESHOLD, _resetSchedulerObservabilityStateForTest } =
      await import("../src/lib/scheduler");
    _resetSchedulerObservabilityStateForTest();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    // Never degraded — recovery is a silent no-op.
    recordLaneFailure("synthetic-stop monitor", "local:acct-3", new TypeError("fetch failed"));
    recordLaneRecovery("synthetic-stop monitor", "local:acct-3");
    expect(sentryMetricsMock.logWarn).not.toHaveBeenCalled();

    // Cross the threshold, then recover — this time recovery must announce.
    for (let i = 0; i < LANE_DEGRADED_STREAK_THRESHOLD; i++) {
      recordLaneFailure("synthetic-stop monitor", "local:acct-3", new TypeError("fetch failed"));
    }
    recordLaneRecovery("synthetic-stop monitor", "local:acct-3");
    expect(sentryMetricsMock.logWarn).toHaveBeenCalledWith(
      "scheduler.lane",
      expect.objectContaining({ event: "lane_recovered", lane: "synthetic-stop monitor", key: "local:acct-3" })
    );
  });
});
