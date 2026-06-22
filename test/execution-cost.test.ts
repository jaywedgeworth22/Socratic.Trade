import { afterEach, describe, expect, it } from "vitest";
import { applyExecutionCost, estimateExecutionCostBps, executionCostConfig } from "../src/lib/execution-cost";

describe("estimateExecutionCostBps", () => {
  it("is zero with no inputs (no base, no spread, no impact)", () => {
    expect(estimateExecutionCostBps({ orderNotional: 1000, baseSlippageBps: 0, impactCoeff: 0 })).toBe(0);
  });

  it("adds the base floor and half the spread", () => {
    const bps = estimateExecutionCostBps({ spreadBps: 20, orderNotional: 0, baseSlippageBps: 5, impactCoeff: 0 });
    expect(bps).toBe(15); // 5 base + 10 half-spread
  });

  it("scales market impact with sqrt of participation (notional / dollar volume)", () => {
    // 1% participation, coeff 10 → 10 * sqrt(0.01) = 1bps
    const liquid = estimateExecutionCostBps({ orderNotional: 10_000, dollarVol: 1_000_000, baseSlippageBps: 0, impactCoeff: 10 });
    expect(liquid).toBeCloseTo(1, 5);
    // 10% participation → 10 * sqrt(0.1) ≈ 3.16bps — costs MORE in a thinner name
    const thin = estimateExecutionCostBps({ orderNotional: 100_000, dollarVol: 1_000_000, baseSlippageBps: 0, impactCoeff: 10 });
    expect(thin).toBeGreaterThan(liquid);
    expect(thin).toBeCloseTo(3.1623, 3);
  });
});

describe("applyExecutionCost — adverse direction", () => {
  it("a buy pays UP", () => {
    expect(applyExecutionCost(100, "buy", 50)).toBeCloseTo(100.5, 6); // +50bps
  });
  it("a cover pays UP", () => {
    expect(applyExecutionCost(100, "cover", 50)).toBeCloseTo(100.5, 6);
  });
  it("a sell receives DOWN", () => {
    expect(applyExecutionCost(100, "sell", 50)).toBeCloseTo(99.5, 6);
  });
  it("a short receives DOWN", () => {
    expect(applyExecutionCost(100, "short", 50)).toBeCloseTo(99.5, 6);
  });
  it("is a no-op for zero cost or zero price", () => {
    expect(applyExecutionCost(100, "buy", 0)).toBe(100);
    expect(applyExecutionCost(0, "buy", 50)).toBe(0);
  });
});

describe("executionCostConfig — default OFF", () => {
  afterEach(() => {
    delete process.env.PAPER_EXECUTION_COST_MODEL;
    delete process.env.PAPER_EXECUTION_COST_BASE_BPS;
    delete process.env.PAPER_EXECUTION_IMPACT_COEFF;
  });

  it("is disabled with no env set", () => {
    expect(executionCostConfig().enabled).toBe(false);
  });

  it("enables via the flag", () => {
    process.env.PAPER_EXECUTION_COST_MODEL = "on";
    const cfg = executionCostConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.impactCoeff).toBe(10); // default
  });

  it("enables via a positive base bps and reads overrides", () => {
    process.env.PAPER_EXECUTION_COST_BASE_BPS = "8";
    process.env.PAPER_EXECUTION_IMPACT_COEFF = "20";
    const cfg = executionCostConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.baseSlippageBps).toBe(8);
    expect(cfg.impactCoeff).toBe(20);
  });
});
