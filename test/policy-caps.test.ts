import { describe, expect, it } from "vitest";
import { effectiveDailyOpeningNotionalCap, resolveDailyOpeningCap } from "../src/lib/policy-caps";

describe("daily opening cap resolution", () => {
  it("uses current NAV for percentage mode", () => {
    expect(resolveDailyOpeningCap({ maxDailyPctOfNav: 20 }, 100)).toEqual({
      mode: "pct_nav",
      configuredValue: 20,
      notional: 20,
      pctOfNav: 20
    });
  });

  it("preserves a legacy explicit dollar mode and reports its NAV scale", () => {
    expect(resolveDailyOpeningCap({ maxDailyNotional: 1_000 }, 100)).toEqual({
      mode: "dollar",
      configuredValue: 1_000,
      notional: 1_000,
      pctOfNav: 1_000
    });
  });

  it("defensively prefers percent if a corrupt legacy shape carries both", () => {
    expect(effectiveDailyOpeningNotionalCap({ maxDailyNotional: 1_000, maxDailyPctOfNav: 20 }, 100)).toBe(20);
  });
});
