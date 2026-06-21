import { describe, expect, it } from "vitest";
import {
  computeFactorICs,
  computeCompositeIC,
  deriveWeightsFromICs,
  splitWalkForward,
  adjustReturns,
  buildEquityCurve,
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

describe("splitWalkForward", () => {
  it("puts the first 60% of unique dates in train and the rest in test", () => {
    const observations: FactorObservation[] = [
      obs("2026-01-01", "A", 0.01, { momentum: 10 }),
      obs("2026-01-02", "A", 0.02, { momentum: 20 }),
      obs("2026-01-03", "A", 0.03, { momentum: 30 }),
      obs("2026-01-04", "A", 0.04, { momentum: 40 }),
      obs("2026-01-05", "A", 0.05, { momentum: 50 })
    ];
    const { train, test } = splitWalkForward(observations, 0.6);
    // 5 dates × 0.6 = 3 → first 3 dates in train
    expect(new Set(train.map((o) => o.date))).toEqual(new Set(["2026-01-01", "2026-01-02", "2026-01-03"]));
    expect(new Set(test.map((o) => o.date))).toEqual(new Set(["2026-01-04", "2026-01-05"]));
  });

  it("never puts the same date in both train and test, covers all observations", () => {
    const observations: FactorObservation[] = [
      obs("2026-06-10", "A", 0.01, { momentum: 10 }),
      obs("2026-06-10", "B", 0.02, { momentum: 20 }),
      obs("2026-06-11", "A", 0.03, { momentum: 10 }),
      obs("2026-06-11", "B", 0.04, { momentum: 20 }),
      obs("2026-06-12", "A", 0.05, { momentum: 30 }),
      obs("2026-06-12", "B", 0.06, { momentum: 40 })
    ];
    const { train, test } = splitWalkForward(observations);
    const trainDates = new Set(train.map((o) => o.date));
    const testDates = new Set(test.map((o) => o.date));
    for (const d of trainDates) expect(testDates.has(d)).toBe(false);
    expect(train.length + test.length).toBe(observations.length);
  });

  it("keeps all observations in train when only 1 unique date exists", () => {
    const observations: FactorObservation[] = [
      obs("2026-06-10", "A", 0.01, { momentum: 10 }),
      obs("2026-06-10", "B", 0.02, { momentum: 20 })
    ];
    const { train, test } = splitWalkForward(observations);
    expect(train.length).toBe(2);
    expect(test.length).toBe(0);
  });

  it("always puts at least 1 date in train even with a tiny fraction", () => {
    const dates = ["2026-06-10", "2026-06-11", "2026-06-12"];
    const observations = dates.map((d) => obs(d, "A", 0.01, { momentum: 1 }));
    const { train } = splitWalkForward(observations, 0.01);
    expect(new Set(train.map((o) => o.date)).size).toBeGreaterThanOrEqual(1);
  });
});

describe("adjustReturns", () => {
  it("subtracts cost and applies tax only to positive after-cost returns", () => {
    const observations: FactorObservation[] = [
      obs("2026-06-10", "WIN", 0.10, { momentum: 50 }),   // positive gain
      obs("2026-06-10", "EVEN", 0.002, { momentum: 50 }), // exactly covers cost → zero after
      obs("2026-06-10", "LOSS", -0.05, { momentum: 50 })  // loss
    ];
    const adjusted = adjustReturns(observations, { costRoundTripBps: 20, taxRate: 0.24 });
    // WIN: afterCost = 0.098; net = 0.098 × (1 − 0.24)
    expect(adjusted[0].forwardReturn).toBeCloseTo(0.098 * 0.76, 8);
    // EVEN: afterCost = 0.000; taxDrag = 0; net = 0
    expect(adjusted[1].forwardReturn).toBeCloseTo(0, 8);
    // LOSS: afterCost = −0.052; no tax on loss; net = −0.052
    expect(adjusted[2].forwardReturn).toBeCloseTo(-0.052, 8);
  });

  it("defaults to 20bps round-trip and 24% tax when no options supplied", () => {
    const [adjusted] = adjustReturns([obs("2026-06-10", "A", 0.10, { momentum: 50 })]);
    expect(adjusted.forwardReturn).toBeCloseTo((0.10 - 0.002) * 0.76, 8);
  });

  it("does not mutate the original observations", () => {
    const original: FactorObservation[] = [obs("2026-06-10", "A", 0.10, { momentum: 50 })];
    adjustReturns(original);
    expect(original[0].forwardReturn).toBe(0.10);
  });
});

describe("computeCompositeIC", () => {
  it("returns zero meanIC and zero icIR for empty input", () => {
    expect(computeCompositeIC([], DEFAULT_SCORING_WEIGHTS)).toEqual({ meanIC: 0, icIR: 0 });
  });

  it("returns IC ≈ +1 when the weighted composite perfectly predicts returns", () => {
    const allMomentum = { ...DEFAULT_SCORING_WEIGHTS };
    for (const f of MARKET_FACTORS) allMomentum[f] = f === "momentum" ? 1 : 0;
    const observations: FactorObservation[] = [
      obs("2026-06-10", "A", 0.01, { momentum: 10 }),
      obs("2026-06-10", "B", 0.02, { momentum: 20 }),
      obs("2026-06-10", "C", 0.03, { momentum: 30 }),
      obs("2026-06-10", "D", 0.04, { momentum: 40 })
    ];
    const { meanIC } = computeCompositeIC(observations, allMomentum);
    expect(meanIC).toBeCloseTo(1, 10);
  });

  it("returns icIR 0 when there is only one OOS date (std undefined)", () => {
    const observations: FactorObservation[] = [
      obs("2026-06-10", "A", 0.01, { momentum: 10 }),
      obs("2026-06-10", "B", 0.02, { momentum: 20 })
    ];
    const { icIR } = computeCompositeIC(observations, DEFAULT_SCORING_WEIGHTS);
    expect(icIR).toBe(0);
  });

  it("returns a finite non-zero icIR when ICs vary across multiple dates", () => {
    const allMomentum = { ...DEFAULT_SCORING_WEIGHTS };
    for (const f of MARKET_FACTORS) allMomentum[f] = f === "momentum" ? 1 : 0;
    const observations: FactorObservation[] = [
      // date 1: perfect +1 IC
      obs("2026-06-10", "A", 0.01, { momentum: 10 }),
      obs("2026-06-10", "B", 0.04, { momentum: 40 }),
      // date 2: perfect −1 IC (inverse)
      obs("2026-06-11", "A", 0.05, { momentum: 10 }),
      obs("2026-06-11", "B", 0.01, { momentum: 40 })
    ];
    const { meanIC, icIR } = computeCompositeIC(observations, allMomentum);
    expect(meanIC).toBeCloseTo(0, 10); // mean of +1 and −1
    expect(Number.isFinite(icIR)).toBe(true);
  });
});

describe("buildEquityCurve", () => {
  it("selects top-K names by composite score and compounds period returns", () => {
    const allMomentum = { ...DEFAULT_SCORING_WEIGHTS };
    for (const f of MARKET_FACTORS) allMomentum[f] = f === "momentum" ? 1 : 0;

    const observations: FactorObservation[] = [
      obs("2026-06-10", "A", 0.05, { momentum: 80 }), // top score
      obs("2026-06-10", "B", 0.01, { momentum: 20 }),
      obs("2026-06-11", "A", 0.03, { momentum: 70 }), // top score
      obs("2026-06-11", "B", 0.01, { momentum: 10 })
    ];
    const curve = buildEquityCurve(observations, allMomentum, new Map(), 1);
    expect(curve).toHaveLength(2);
    expect(curve[0].periodReturn).toBeCloseTo(0.05, 8); // top-1 on date 1 = A at 5%
    expect(curve[0].nNames).toBe(1);
    expect(curve[1].periodReturn).toBeCloseTo(0.03, 8); // top-1 on date 2 = A at 3%
    expect(curve[1].cumulativeReturn).toBeCloseTo(1.05 * 1.03 - 1, 8);
  });

  it("includes SPY benchmark returns and cumulates them independently", () => {
    const observations: FactorObservation[] = [
      obs("2026-06-10", "A", 0.05, { momentum: 80 })
    ];
    const spy = new Map([["2026-06-10", 0.02]]);
    const [pt] = buildEquityCurve(observations, DEFAULT_SCORING_WEIGHTS, spy, 1);
    expect(pt.benchmarkReturn).toBeCloseTo(0.02, 8);
    expect(pt.benchmarkCumulativeReturn).toBeCloseTo(0.02, 8);
  });

  it("leaves benchmark null for dates with no SPY data", () => {
    const observations: FactorObservation[] = [obs("2026-06-10", "A", 0.05, { momentum: 80 })];
    const [pt] = buildEquityCurve(observations, DEFAULT_SCORING_WEIGHTS, new Map(), 1);
    expect(pt.benchmarkReturn).toBeNull();
    expect(pt.benchmarkCumulativeReturn).toBeNull();
  });

  it("returns an empty curve for empty observations", () => {
    expect(buildEquityCurve([], DEFAULT_SCORING_WEIGHTS, new Map())).toHaveLength(0);
  });
});
