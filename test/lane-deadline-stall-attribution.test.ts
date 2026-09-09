// Attribution of a blown safety-lane deadline: broker latency vs a pinned event loop.
//
// Production evidence this encodes (2026-09-09, task_journal on container d83b1aykr03uwr32yhgzaiay):
//   stale-limit-scan @ 2026-09-08T19:51:57.566Z ran 185_633ms carrying the inner error
//   "Timed out waiting for alpaca.getOrders after 16000+8000ms." — the broker call gave up at
//   24s, so 161_633ms of that lane was NOT broker I/O.  synthetic-stop-monitor @
//   2026-09-09T13:45:41.103Z ran 196_840ms and finished `ok evaluated=6`.  The lane succeeded;
//   the deadline had already blamed the broker.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  withLaneDeadline,
  isLaneDeadlineExpiry,
  LANE_STALL_ATTRIBUTION_RATIO,
  type LaneDeadlineExpiry
} from "../src/lib/safety-maintenance";
import {
  stalledMsSince,
  startEventLoopLagSampler,
  _resetEventLoopLagForTest,
  _recordEventLoopLagForTest
} from "../src/lib/event-loop-lag";
import { classifyLaneFailure } from "../src/lib/scheduler";

const never = () => new Promise<void>(() => {});

describe("event-loop lag accounting", () => {
  beforeEach(() => _resetEventLoopLagForTest());
  afterEach(() => _resetEventLoopLagForTest());

  it("sums only stalls inside the queried window", () => {
    const now = Date.now();
    _recordEventLoopLagForTest(now - 30_000, 9_000); // before the window — ignored
    _recordEventLoopLagForTest(now - 5_000, 4_000); // inside
    expect(stalledMsSince(now - 10_000)).toBeGreaterThanOrEqual(4_000);
    expect(stalledMsSince(now - 10_000)).toBeLessThan(9_000);
  });

  it("reports no stall on a healthy loop", () => {
    startEventLoopLagSampler();
    expect(stalledMsSince(Date.now() - 1_000)).toBe(0);
  });

  it("clamps a sample that straddles the window start", () => {
    const now = Date.now();
    // A 10s stall observed 2s ago can only have contributed 2s to a window that began then.
    _recordEventLoopLagForTest(now - 2_000, 10_000);
    expect(stalledMsSince(now - 2_500)).toBeLessThanOrEqual(2_500);
  });
});

describe("withLaneDeadline", () => {
  beforeEach(() => _resetEventLoopLagForTest());
  afterEach(() => {
    _resetEventLoopLagForTest();
    vi.restoreAllMocks();
  });

  it("passes a value straight through when the work beats the deadline", async () => {
    await expect(withLaneDeadline(Promise.resolve("ok"), 1_000, "m", "lane")).resolves.toBe("ok");
  });

  it("passes a REAL lane error through untouched — only the deadline's own expiry is re-attributed", async () => {
    const real = new Error("broker returned 500");
    await expect(withLaneDeadline(Promise.reject(real), 1_000, "m", "lane")).rejects.toBe(real);
  });

  it("attributes an expiry to the event loop when the loop was pinned for most of the window", async () => {
    let err: unknown;
    try {
      await withLaneDeadline(never(), 40, "runSyntheticStopMonitor timeout", "synthetic-stop-monitor");
    } catch (e) {
      err = e;
    }
    expect(isLaneDeadlineExpiry(err)).toBe(true);
    expect((err as LaneDeadlineExpiry).elapsedMs).toBeGreaterThan(0);
    expect((err as LaneDeadlineExpiry).stalledMs).toBeGreaterThanOrEqual(0);
  });

  it("classifies a stall-dominated expiry as event_loop_stall, NOT a broker timeout", () => {
    const stall = Object.assign(new Error("runSyntheticStopMonitor timeout — event-loop stall 12000ms of 15000ms (80%)"), {
      __laneDeadlineExpiry: true as const,
      elapsedMs: 15_000,
      stalledMs: 12_000,
      stallRatio: 0.8
    });
    expect(classifyLaneFailure(stall)).toBe("event_loop_stall");
  });

  it("still classifies a genuinely broker-bound expiry as timeout", () => {
    const brokerBound = Object.assign(new Error("stale-limit-scan broker timeout (elapsed=15000ms, event-loop stall=120ms)"), {
      __laneDeadlineExpiry: true as const,
      elapsedMs: 15_000,
      stalledMs: 120,
      stallRatio: 0.008
    });
    expect(classifyLaneFailure(brokerBound)).toBe("timeout");
  });

  it("holds the attribution threshold at a conservative quarter of the window", () => {
    expect(LANE_STALL_ATTRIBUTION_RATIO).toBe(0.25);
    const justUnder = Object.assign(new Error("runSyntheticStopMonitor timeout"), {
      __laneDeadlineExpiry: true as const,
      elapsedMs: 15_000,
      stalledMs: 3_000,
      stallRatio: 0.2
    });
    // Below the bar we keep blaming the broker — a real outage is never explained away.
    expect(classifyLaneFailure(justUnder)).toBe("timeout");
  });

  it("SAFETY: the deadline never cancels the protective pass — late work still completes", async () => {
    let completed = false;
    const work = new Promise<string>((resolve) =>
      setTimeout(() => {
        completed = true;
        resolve("evaluated=6");
      }, 60)
    );
    await expect(withLaneDeadline(work, 20, "runSyntheticStopMonitor timeout", "synthetic-stop-monitor")).rejects.toThrow();
    await work;
    expect(completed).toBe(true);
  });

  it("SAFETY: a late completion is announced so an operator can tell the pass actually ran", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const work = new Promise<string>((resolve) => setTimeout(() => resolve("evaluated=6"), 60));
    await withLaneDeadline(work, 20, "runSyntheticStopMonitor timeout", "synthetic-stop-monitor").catch(() => undefined);
    await work;
    await new Promise((r) => setTimeout(r, 10));
    expect(warn.mock.calls.some((c) => String(c[0]).includes("COMPLETED LATE"))).toBe(true);
  });
});
