import { describe, expect, it } from "vitest";
import { determineMarketRegime, evaluateVolatilityBrake, pruneMacro } from "../src/lib/macro";
import type { MacroData } from "../src/lib/macro";

const base: MacroData = {
  fedFundsRate: "5.25%",
  dgs3moTreasury: "5.10%",
  dgs2Treasury: "4.60%",
  dgs10Treasury: "4.20%",
  inflationExpectation10y: "2.30%",
  cpiInflation: "3.10%",
  corePCE: "2.80%",
  realGDPGrowth: "2.00%",
  unemploymentRate: "3.90%",
  initialClaims: "220K",
  m2MoneySupply: "20.8T",
  m2GrowthYoY: "2.50%",
  hyCreditSpread: "3.20%",
  usdIndex: "121.00",
  wtiOil: "$75.00",
  housingStarts: "1.3M",
  consumerSentiment: "75.0",
  vix: "15.00",
  vix3m: "17.00",
  asOf: "2026-06-16"
};

describe("determineMarketRegime", () => {
  it("uses VIX for the primary volatility tier", () => {
    expect(determineMarketRegime({ ...base, vix: "35" })).toContain("Crisis");
    expect(determineMarketRegime({ ...base, vix: "24" })).toContain("Risk-Off");
    expect(determineMarketRegime({ ...base, vix: "11", fedFundsRate: "2.00%", dgs10Treasury: "4.00%" })).toContain("Risk-On");
    expect(determineMarketRegime({ ...base, vix: "16", fedFundsRate: "2.00%", dgs10Treasury: "4.00%" })).toContain("Neutral");
  });

  it("lets an inverted yield curve actually influence the regime (rates now matter)", () => {
    // Calm VIX but inverted curve (10y < fed funds) -> Cautious, not Risk-On.
    expect(determineMarketRegime({ ...base, vix: "12", fedFundsRate: "5.25%", dgs10Treasury: "4.20%" })).toContain("Cautious");
    // Borderline VIX + inversion tips into Risk-Off.
    expect(determineMarketRegime({ ...base, vix: "18", fedFundsRate: "5.25%", dgs10Treasury: "4.20%" })).toContain("Risk-Off");
  });
});

describe("determineMarketRegime — VIX fallback light-macro", () => {
  it("returns a real regime when asOf is a date (VIX light-macro path)", () => {
    // When fetchVixFromYahoo succeeds, asOf is today's date (not 'unavailable').
    // The regime should be derived from the live VIX.
    const lightMacro: MacroData = { ...base, vix: "28.50", asOf: "2026-06-21" };
    expect(determineMarketRegime(lightMacro)).toBe("Risk-Off (High Volatility)");
  });

  it("returns Unknown when asOf is 'unavailable' (no FRED key AND VIX fetch failed)", () => {
    const noMacro: MacroData = { ...base, asOf: "unavailable" };
    expect(determineMarketRegime(noMacro)).toBe("Unknown (no macro feed)");
  });
});

describe("evaluateVolatilityBrake", () => {
  const calm = { ...base, vix: "15.00" };
  it("does not brake in calm conditions", () => {
    const r = evaluateVolatilityBrake(calm, { vvix: 90, skew: 120 }, { volPanicBrakeEnabled: true });
    expect(r.brake).toBe(false);
  });

  it("brakes on an extreme VIX tail", () => {
    const r = evaluateVolatilityBrake({ ...base, vix: "42" }, undefined, { volPanicBrakeEnabled: true });
    expect(r.brake).toBe(true);
    expect(r.reason).toContain("VIX");
  });

  it("brakes on VVIX or SKEW even when VIX is calm", () => {
    expect(evaluateVolatilityBrake(calm, { vvix: 160 }, { volPanicBrakeEnabled: true }).brake).toBe(true);
    expect(evaluateVolatilityBrake(calm, { skew: 165 }, { volPanicBrakeEnabled: true }).brake).toBe(true);
  });

  it("respects custom thresholds", () => {
    expect(evaluateVolatilityBrake({ ...base, vix: "28" }, undefined, { volPanicBrakeEnabled: true, volPanicVixThreshold: 25 }).brake).toBe(true);
    expect(evaluateVolatilityBrake({ ...base, vix: "28" }, undefined, { volPanicBrakeEnabled: true, volPanicVixThreshold: 40 }).brake).toBe(false);
  });

  it("is disabled when volPanicBrakeEnabled === false", () => {
    expect(evaluateVolatilityBrake({ ...base, vix: "99" }, { vvix: 999, skew: 999 }, { volPanicBrakeEnabled: false }).brake).toBe(false);
  });

  it("never trips on unavailable macro or missing gauges (no false-trip on partial data)", () => {
    expect(evaluateVolatilityBrake({ ...base, asOf: "unavailable", vix: "99" }, undefined, { volPanicBrakeEnabled: true }).brake).toBe(false);
    expect(evaluateVolatilityBrake(undefined, undefined, { volPanicBrakeEnabled: true }).brake).toBe(false);
  });
});

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

  it("never leaks the fredSourced meta flag into the LLM prompt payload (first run and delta)", () => {
    const flagged: MacroData = { ...base, fredSourced: true };

    // First run: the flag is excluded from the prompt record entirely.
    const first = pruneMacro(flagged);
    expect(Object.keys(first.macro)).not.toContain("fredSourced");
    expect(first.omitted).not.toContain("fredSourced");
    // …and the string data fields all still go through.
    expect(Object.keys(first.macro).sort()).toEqual(Object.keys(base).sort());

    // Delta run (flag flipped between runs): still never surfaces in macro OR omitted.
    const next: MacroData = { ...base, fredSourced: false, cpiInflation: "3.40%" };
    const delta = pruneMacro(next, flagged);
    expect(Object.keys(delta.macro)).not.toContain("fredSourced");
    expect(delta.omitted).not.toContain("fredSourced");
    expect(delta.macro.cpiInflation).toBe("3.40%");
  });
});
