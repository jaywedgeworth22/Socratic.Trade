import { describe, expect, it } from "vitest";
import { describeLastRun, LAST_RUN_CAUSE_CHARS } from "../app/console/lib/last-run";

describe("console home last-run line", () => {
  it("surfaces the persisted failure cause instead of dropping it", () => {
    const d = describeLastRun({ status: "failed", summary: "Kill switch is active." });
    expect(d.failed).toBe(true);
    expect(d.cause).toBe("Kill switch is active.");
    expect(d.title).toBe("Kill switch is active.");
  });

  it("truncates a long cause inline but keeps the whole thing for the tooltip", () => {
    const summary =
      "Process restarted mid-run - marked failed by stale-run sweep after the scheduler lease expired.";
    expect(summary.length).toBeGreaterThan(LAST_RUN_CAUSE_CHARS);

    const d = describeLastRun({ status: "failed", summary });
    expect(d.cause).toBe(`${summary.slice(0, LAST_RUN_CAUSE_CHARS).trimEnd()}...`);
    expect(d.cause!.length).toBeLessThanOrEqual(LAST_RUN_CAUSE_CHARS + 3);
    expect(d.title).toBe(summary);
  });

  it("renders nothing extra for a failed run that recorded no summary", () => {
    // Guards the dangling "Last run failed -" with nothing after it.
    expect(describeLastRun({ status: "failed", summary: undefined }).cause).toBeUndefined();
    expect(describeLastRun({ status: "failed", summary: "   " })).toEqual({
      failed: true,
      title: undefined,
      cause: undefined
    });
  });

  it("leaves non-failed runs muted and uncluttered", () => {
    const completed = describeLastRun({ status: "completed", summary: "Placed 2 orders." });
    expect(completed.failed).toBe(false);
    expect(completed.cause).toBeUndefined();
    expect(completed.title).toBe("Placed 2 orders.");

    // `skipped` is the routine off-hours gate and the strategy bar already shows
    // that state as a chip - the reason belongs in the tooltip only.
    const skipped = describeLastRun({ status: "skipped", summary: "Market closed." });
    expect(skipped.cause).toBeUndefined();
    expect(skipped.title).toBe("Market closed.");
  });
});
