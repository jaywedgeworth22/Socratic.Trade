import { describe, it, expect } from "vitest";
import {
  tierTone,
  tierLabel,
  formatStrategyDirectiveBlock,
  relativeDate
} from "../src/lib/learned-context-queue-helpers";

describe("tierTone", () => {
  it("maps risk to warn", () => {
    expect(tierTone("risk")).toBe("warn");
  });
  it("maps strategy-directive to info", () => {
    expect(tierTone("strategy-directive")).toBe("info");
  });
});

describe("tierLabel", () => {
  it("returns Risk for risk tier", () => {
    expect(tierLabel("risk")).toBe("Risk");
  });
  it("returns Strategy Directive for strategy-directive tier", () => {
    expect(tierLabel("strategy-directive")).toBe("Strategy Directive");
  });
});

describe("formatStrategyDirectiveBlock", () => {
  it("wraps value in AI-LEARNED comment block with date prefix", () => {
    const result = formatStrategyDirectiveBlock("abc123", "2026-06-21T10:00:00Z", "Avoid meme stocks.");
    expect(result).toBe(
      "<!-- AI-LEARNED abc123 2026-06-21 -->\nAvoid meme stocks.\n<!-- /AI-LEARNED -->"
    );
  });

  it("trims ISO datetime to date portion", () => {
    const result = formatStrategyDirectiveBlock("x1", "2026-01-15T08:30:00.000Z", "focus on tech");
    expect(result.startsWith("<!-- AI-LEARNED x1 2026-01-15 -->")).toBe(true);
  });

  it("preserves a raw date-only string as-is", () => {
    const result = formatStrategyDirectiveBlock("y2", "2026-03-04", "value");
    expect(result.startsWith("<!-- AI-LEARNED y2 2026-03-04 -->")).toBe(true);
  });

  it("preserves multi-line values verbatim", () => {
    const value = "line one\nline two";
    const result = formatStrategyDirectiveBlock("z3", "2026-06-01", value);
    expect(result).toContain("line one\nline two");
  });
});

describe("relativeDate", () => {
  const BASE = new Date("2026-06-21T12:00:00Z");

  it("returns Today for same day", () => {
    expect(relativeDate("2026-06-21T09:00:00Z", BASE)).toBe("Today");
  });

  it("returns Yesterday for 1-day-ago timestamps", () => {
    expect(relativeDate("2026-06-20T08:00:00Z", BASE)).toBe("Yesterday");
  });

  it("returns N days ago for 2–6 days back", () => {
    expect(relativeDate("2026-06-18T12:00:00Z", BASE)).toBe("3 days ago");
    expect(relativeDate("2026-06-15T12:00:00Z", BASE)).toBe("6 days ago");
  });

  it("returns ISO date for 7+ days back", () => {
    // BASE is 2026-06-21; 2026-06-13 is 8 days back → falls through to ISO date display
    expect(relativeDate("2026-06-13T12:00:00Z", BASE)).toBe("2026-06-13");
  });

  it("returns the original string for an invalid date", () => {
    expect(relativeDate("not-a-date", BASE)).toBe("not-a-date");
  });
});
