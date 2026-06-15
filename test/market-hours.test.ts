import { describe, expect, it } from "vitest";
import { currentMarketSession, isRunAllowedNow } from "../src/lib/market-hours";

// Helper: build a UTC Date that lands at a specific ET wall-clock time.
// EDT (summer, UTC-4): utcHour = etHour + 4
// EST (winter, UTC-5): utcHour = etHour + 5
// These tests use dates in June (EDT, UTC-4) unless noted.

function etDate(isoDate: string, etHour: number, etMinute = 0): Date {
  // June is always EDT (UTC-4)
  const utcHour = etHour + 4;
  const paddedDate = isoDate; // "YYYY-MM-DD"
  // Build ISO UTC string; if utcHour >= 24 we'd need to bump the day, but test cases avoid that
  return new Date(`${paddedDate}T${String(utcHour).padStart(2, "0")}:${String(etMinute).padStart(2, "0")}:00Z`);
}

describe("currentMarketSession", () => {
  it("Wednesday 10:00 ET → regular", () => {
    // 2026-06-10 is a Wednesday
    const d = etDate("2026-06-10", 10, 0);
    expect(currentMarketSession(d)).toBe("regular");
  });

  it("Wednesday 08:00 ET → pre", () => {
    const d = etDate("2026-06-10", 8, 0);
    expect(currentMarketSession(d)).toBe("pre");
  });

  it("Wednesday 18:00 ET → post", () => {
    const d = etDate("2026-06-10", 18, 0);
    expect(currentMarketSession(d)).toBe("post");
  });

  it("Wednesday 09:30 ET (exactly open) → regular", () => {
    const d = etDate("2026-06-10", 9, 30);
    expect(currentMarketSession(d)).toBe("regular");
  });

  it("Wednesday 16:00 ET (exactly close) → post", () => {
    const d = etDate("2026-06-10", 16, 0);
    expect(currentMarketSession(d)).toBe("post");
  });

  it("Wednesday 20:00 ET (post-market close) → closed", () => {
    const d = etDate("2026-06-10", 20, 0);
    expect(currentMarketSession(d)).toBe("closed");
  });

  it("Wednesday 03:00 ET (before pre-market) → closed", () => {
    const d = etDate("2026-06-10", 3, 0);
    expect(currentMarketSession(d)).toBe("closed");
  });

  it("Saturday → closed", () => {
    // 2026-06-13 is a Saturday
    const d = etDate("2026-06-13", 10, 0);
    expect(currentMarketSession(d)).toBe("closed");
  });

  it("Sunday → closed", () => {
    // 2026-06-14 is a Sunday
    const d = etDate("2026-06-14", 10, 0);
    expect(currentMarketSession(d)).toBe("closed");
  });
});

describe("isRunAllowedNow", () => {
  it("regular session → true regardless of extended-hours flag", () => {
    const d = etDate("2026-06-10", 10, 0);
    expect(isRunAllowedNow(false, d)).toBe(true);
    expect(isRunAllowedNow(true, d)).toBe(true);
  });

  it("pre-market, extended=false → false", () => {
    const d = etDate("2026-06-10", 8, 0);
    expect(isRunAllowedNow(false, d)).toBe(false);
  });

  it("pre-market, extended=true → true", () => {
    const d = etDate("2026-06-10", 8, 0);
    expect(isRunAllowedNow(true, d)).toBe(true);
  });

  it("post-market, extended=false → false", () => {
    const d = etDate("2026-06-10", 18, 0);
    expect(isRunAllowedNow(false, d)).toBe(false);
  });

  it("post-market, extended=true → true", () => {
    const d = etDate("2026-06-10", 18, 0);
    expect(isRunAllowedNow(true, d)).toBe(true);
  });

  it("closed (Saturday) → false regardless of extended-hours", () => {
    const d = etDate("2026-06-13", 12, 0);
    expect(isRunAllowedNow(false, d)).toBe(false);
    expect(isRunAllowedNow(true, d)).toBe(false);
  });
});
