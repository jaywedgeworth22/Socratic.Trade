import { describe, expect, it } from "vitest";
import {
  computeFactorICs,
  deriveWeightsFromICs,
  MARKET_FACTORS,
  type FactorIC,
  type FactorObservation
} from "../src/lib/backtest";
import { DEFAULT_SCORING_WEIGHTS } from "../src/lib/defaults";
import type { MarketFactor } from "../src/lib/types";

// Pure-function tests only — no db, no network. computeFactorICs and deriveWeightsFromICs
// are Date.now()-free, so these fixtures fully determine the outputs.

/** Build a full sub-score map, defaulting unspecified factors to a neutral 0. */
function subScores(partial: Partial<Record<MarketFactor, number>>): Record<MarketFactor, number> {
  const out = {} as Record<MarketFactor, number>;
  for (const factor of MARKET_FACTORS) out[factor] = partial[factor] ?? 0;
  return out;
}

function obs(
  date: string,
  symbol: string,
  forwardReturn: number,
  scores: Partial<Record<MarketFactor, number>>
): FactorObservation {
  return { date, symbol, forwardReturn, subScores: subScores(scores) };
}

function icFor(ics: FactorIC[], factor: MarketFactor): FactorIC {
  const found = ics.find((entry) => entry.factor === factor);
  if (!found) throw new Error(`missing IC for ${factor}`);
  return found;
}

describe("computeFactorICs", () => {
  it("returns one entry per market factor in canonical order", () => {
    const ics = computeFactorICs([]);
    expect(ics.map((entry) => entry.factor)).toEqual(MARKET_FACTORS);
    // Empty input → every factor has ic 0 and n 0 (no contributing dates).
    for (const entry of ics) {
      expect(entry).toMatchObject({ ic: 0, n: 0 });
    }
  });

  it("scores a perfectly monotone factor at IC +1 and its inverse at -1", () => {
    // Within one date: momentum rises with return, value falls with it.
    const observations: FactorObservation[] = [
      obs("2026-06-10", "AAA", 0.01, { momentum: 10, value: 90 }),
      obs("2026-06-10", "BBB", 0.02, { momentum: 20, value: 80 }),
      obs("2026-06-10", "CCC", 0.03, { momentum: 30, value: 70 }),
      obs("2026-06-10", "DDD", 0.04, { momentum: 40, value: 60 })
    ];
    const ics = computeFactorICs(observations);
    expect(icFor(ics, "momentum").ic).toBeCloseTo(1, 10);
    expect(icFor(ics, "momentum").n).toBe(1);
    expect(icFor(ics, "value").ic).toBeCloseTo(-1, 10);
  });

  it("handles ties via average ranks (tie-corrected Spearman)", () => {
    // Two names share the same sub-score; the average-rank correlation stays finite.
    const observations: FactorObservation[] = [
      obs("2026-06-11", "AAA", 0.01, { momentum: 10 }),
      obs("2026-06-11", "BBB", 0.02, { momentum: 20 }),
      obs("2026-06-11", "CCC", 0.03, { momentum: 20 }), // tie with BBB
      obs("2026-06-11", "DDD", 0.04, { momentum: 40 })
    ];
    const ic = icFor(computeFactorICs(observations), "momentum").ic;
    expect(Number.isFinite(ic)).toBe(true);
    // Monotone-with-a-tie ⇒ strongly positive but below a clean +1.
    expect(ic).toBeGreaterThan(0.9);
    expect(ic).toBeLessThan(1);
  });

  it("averages per-date ICs and counts only dates with >=2 usable names", () => {
    const observations: FactorObservation[] = [
      // Date 1: perfectly monotone → +1
      obs("2026-06-10", "AAA", 0.01, { momentum: 10 }),
      obs("2026-06-10", "BBB", 0.02, { momentum: 20 }),
      // Date 2: perfectly inverse → -1
      obs("2026-06-11", "AAA", 0.04, { momentum: 10 }),
      obs("2026-06-11", "BBB", 0.03, { momentum: 20 }),
      // Date 3: a single name → cannot rank, must not count
      obs("2026-06-12", "AAA", 0.05, { momentum: 99 })
    ];
    const entry = icFor(computeFactorICs(observations), "momentum");
    expect(entry.n).toBe(2);
    expect(entry.ic).toBeCloseTo(0, 10); // mean of +1 and -1
  });

  it("ignores a date where the factor sub-score has zero variance", () => {
    // All sub-scores equal ⇒ rank variance is zero ⇒ correlation undefined ⇒ date skipped.
    const observations: FactorObservation[] = [
      obs("2026-06-10", "AAA", 0.01, { momentum: 50 }),
      obs("2026-06-10", "BBB", 0.02, { momentum: 50 }),
      obs("2026-06-10", "CCC", 0.03, { momentum: 50 })
    ];
    const entry = icFor(computeFactorICs(observations), "momentum");
    expect(entry.n).toBe(0);
    expect(entry.ic).toBe(0);
  });

  it("skips non-finite sub-scores and returns when counting usable names", () => {
    const observations: FactorObservation[] = [
      obs("2026-06-10", "AAA", 0.01, { momentum: 10 }),
      obs("2026-06-10", "BBB", Number.NaN, { momentum: 20 }), // bad return → dropped
      obs("2026-06-10", "CCC", 0.03, { momentum: 30 })
    ];
    const entry = icFor(computeFactorICs(observations), "momentum");
    // Only AAA and CCC remain → still a valid 2-name date.
    expect(entry.n).toBe(1);
    expect(entry.ic).toBeCloseTo(1, 10);
  });
});

describe("deriveWeightsFromICs", () => {
  it("floors negatives at zero and normalizes positives to sum to 1", () => {
    const ics: FactorIC[] = MARKET_FACTORS.map((factor) => ({ factor, ic: 0, n: 1 }));
    // momentum +0.3, value +0.1, quality -0.5 (floored), rest 0.
    ics.find((e) => e.factor === "momentum")!.ic = 0.3;
    ics.find((e) => e.factor === "value")!.ic = 0.1;
    ics.find((e) => e.factor === "quality")!.ic = -0.5;

    const weights = deriveWeightsFromICs(ics);
    const total = MARKET_FACTORS.reduce((sum, factor) => sum + weights[factor], 0);
    expect(total).toBeCloseTo(1, 10);
    expect(weights.momentum).toBeCloseTo(0.75, 10); // 0.3 / 0.4
    expect(weights.value).toBeCloseTo(0.25, 10); // 0.1 / 0.4
    expect(weights.quality).toBe(0); // negative → floored
    expect(weights.liquidity).toBe(0);
  });

  it("falls back to DEFAULT_SCORING_WEIGHTS when all ICs are non-positive", () => {
    const ics: FactorIC[] = MARKET_FACTORS.map((factor) => ({ factor, ic: -0.2, n: 3 }));
    const weights = deriveWeightsFromICs(ics);
    expect(weights).toEqual(DEFAULT_SCORING_WEIGHTS);
    // Returns a copy, not the shared default reference (no accidental mutation).
    expect(weights).not.toBe(DEFAULT_SCORING_WEIGHTS);
  });

  it("uses a provided fallback when supplied and all ICs are non-positive", () => {
    const fallback = { ...DEFAULT_SCORING_WEIGHTS, momentum: 9 };
    const ics: FactorIC[] = MARKET_FACTORS.map((factor) => ({ factor, ic: 0, n: 0 }));
    expect(deriveWeightsFromICs(ics, fallback)).toEqual(fallback);
  });

  it("treats a single positive factor as full weight", () => {
    const ics: FactorIC[] = MARKET_FACTORS.map((factor) => ({ factor, ic: 0, n: 1 }));
    ics.find((e) => e.factor === "liquidity")!.ic = 0.42;
    const weights = deriveWeightsFromICs(ics);
    expect(weights.liquidity).toBeCloseTo(1, 10);
    for (const factor of MARKET_FACTORS) {
      if (factor !== "liquidity") expect(weights[factor]).toBe(0);
    }
  });
});
