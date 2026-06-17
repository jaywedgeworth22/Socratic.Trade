import { describe, expect, it } from "vitest";
import { pruneMacro } from "../src/lib/macro";
import type { MacroData } from "../src/lib/macro";

const base: MacroData = {
  fedFundsRate: "5.25%",
  dgs10Treasury: "4.20%",
  cpiInflation: "3.10%",
  unemploymentRate: "3.90%",
  m2MoneySupply: "20.8T",
  housingStarts: "1.3M",
  consumerSentiment: "75.0",
  vix: "15.00",
  asOf: "2026-06-16"
};

describe("pruneMacro", () => {
  it("sends every field on the first run (no previous snapshot)", () => {
    const { macro, omitted } = pruneMacro(base);
    expect(omitted).toEqual([]);
    expect(Object.keys(macro).sort()).toEqual(Object.keys(base).sort());
  });

  it("omits unchanged slow-moving fields but keeps regime-critical ones", () => {
    const next: MacroData = { ...base, cpiInflation: "3.40%", asOf: "2026-06-17" };
    const { macro, omitted } = pruneMacro(next, base);

    // Changed field is included.
    expect(macro.cpiInflation).toBe("3.40%");
    // Regime-critical fields are always included even when unchanged.
    expect(macro.vix).toBe("15.00");
    expect(macro.fedFundsRate).toBe("5.25%");
    expect(macro.dgs10Treasury).toBe("4.20%");
    // Unchanged, non-critical fields are omitted to save tokens.
    expect(omitted).toContain("unemploymentRate");
    expect(omitted).toContain("m2MoneySupply");
    expect(omitted).toContain("consumerSentiment");
    expect(omitted).not.toContain("cpiInflation");
    expect(omitted).not.toContain("vix");
  });
});
