import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { accountEquity, evaluateDrawdownBreaker } from "../src/lib/risk-breaker";
import type { RiskRules } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-risk-breaker-${randomUUID()}.db`)}`;
});

describe("evaluateDrawdownBreaker (pure)", () => {
  it("no breach when neither limit is configured", () => {
    expect(evaluateDrawdownBreaker({ equity: 5000, highWaterMark: 10000, startOfDayEquity: 9000 })).toEqual({ breached: false });
  });

  it("breaches on trailing drawdown at/over the limit, not below it", () => {
    // 10000 HWM → 8500 equity = 15% drawdown.
    expect(evaluateDrawdownBreaker({ equity: 8500, highWaterMark: 10000, startOfDayEquity: 10000, maxDrawdownPct: 15 }).breached).toBe(true);
    expect(evaluateDrawdownBreaker({ equity: 8501, highWaterMark: 10000, startOfDayEquity: 10000, maxDrawdownPct: 15 }).breached).toBe(false); // 14.99% < 15%
    const r = evaluateDrawdownBreaker({ equity: 8000, highWaterMark: 10000, startOfDayEquity: 10000, maxDrawdownPct: 15 });
    expect(r.breached).toBe(true);
    expect(r.reason).toContain("drawdown");
  });

  it("ignores drawdown when maxDrawdownPct<=0 or highWaterMark<=0", () => {
    expect(evaluateDrawdownBreaker({ equity: 1, highWaterMark: 10000, startOfDayEquity: 10000, maxDrawdownPct: 0 }).breached).toBe(false);
    expect(evaluateDrawdownBreaker({ equity: 1, highWaterMark: 0, startOfDayEquity: 10000, maxDrawdownPct: 15 }).breached).toBe(false);
  });

  it("breaches on daily loss at/over the notional limit, not below it", () => {
    // start-of-day 10000 → equity 9000 = $1000 loss.
    expect(evaluateDrawdownBreaker({ equity: 9000, highWaterMark: 10000, startOfDayEquity: 10000, maxDailyLossNotional: 1000 }).breached).toBe(true);
    expect(evaluateDrawdownBreaker({ equity: 9001, highWaterMark: 10000, startOfDayEquity: 10000, maxDailyLossNotional: 1000 }).breached).toBe(false);
    expect(evaluateDrawdownBreaker({ equity: 9000, highWaterMark: 10000, startOfDayEquity: 10000, maxDailyLossNotional: 1000 }).reason).toContain("daily-loss");
  });

  it("drawdown takes PRIORITY when both are breached", () => {
    const r = evaluateDrawdownBreaker({ equity: 7000, highWaterMark: 10000, startOfDayEquity: 10000, maxDrawdownPct: 15, maxDailyLossNotional: 1000 });
    expect(r.breached).toBe(true);
    expect(r.reason).toContain("drawdown"); // not the daily-loss reason
  });

  it("a profitable day with no peak drawdown never breaches", () => {
    expect(evaluateDrawdownBreaker({ equity: 11000, highWaterMark: 11000, startOfDayEquity: 10000, maxDrawdownPct: 15, maxDailyLossNotional: 1000 }).breached).toBe(false);
  });
});

describe("accountEquity", () => {
  it("prefers composed cash + equity + option market value", () => {
    expect(accountEquity({ cash: 5000, equityMarketValue: 3000, optionMarketValue: 500, totalMarketValue: 1 })).toBe(8500);
  });
  it("falls back to totalMarketValue when the composed value is non-positive", () => {
    expect(accountEquity({ cash: 0, equityMarketValue: 0, optionMarketValue: 0, totalMarketValue: 4200 })).toBe(4200);
  });
});

describe("recordAndEvaluateDrawdownBreaker (stateful HWM + start-of-day persistence)", () => {
  const rules: RiskRules = { maxDrawdownPct: 20, maxDailyLossNotional: 1500 };
  const base = { accountNumber: "ACCT-RB", source: "paper" as const, riskRules: rules, userId: "local" };

  it("seeds HWM + start-of-day on first observation and does not breach", async () => {
    const { recordAndEvaluateDrawdownBreaker } = await import("../src/lib/risk-breaker");
    const r = recordAndEvaluateDrawdownBreaker({ ...base, equity: 10000, now: new Date("2026-06-26T14:00:00Z") });
    expect(r.breached).toBe(false);
    expect(r.highWaterMark).toBe(10000);
    expect(r.startOfDayEquity).toBe(10000);
  });

  it("ratchets the HWM UP and never down; drawdown is measured from the peak", async () => {
    const { recordAndEvaluateDrawdownBreaker } = await import("../src/lib/risk-breaker");
    recordAndEvaluateDrawdownBreaker({ ...base, equity: 12000, now: new Date("2026-06-26T15:00:00Z") }); // new peak
    const drop = recordAndEvaluateDrawdownBreaker({ ...base, equity: 11000, now: new Date("2026-06-26T16:00:00Z") }); // dip
    expect(drop.highWaterMark).toBe(12000); // HWM stayed at peak, not lowered to 11000
    // 12000 → 9000 = 25% > 20% → breach measured from the 12000 peak, not from a lower later value.
    const breach = recordAndEvaluateDrawdownBreaker({ ...base, equity: 9000, now: new Date("2026-06-26T17:00:00Z") });
    expect(breach.highWaterMark).toBe(12000);
    expect(breach.breached).toBe(true);
    expect(breach.reason).toContain("drawdown");
  });

  it("keeps the SAME start-of-day equity across intraday calls, then resets on a new day", async () => {
    const { recordAndEvaluateDrawdownBreaker } = await import("../src/lib/risk-breaker");
    const acct = { ...base, accountNumber: "ACCT-SOD" };
    const open = recordAndEvaluateDrawdownBreaker({ ...acct, equity: 20000, now: new Date("2026-06-26T14:30:00Z") });
    expect(open.startOfDayEquity).toBe(20000);
    // Later same day, lower equity → SOD unchanged (daily loss accrues from the day's open).
    const later = recordAndEvaluateDrawdownBreaker({ ...acct, equity: 19000, now: new Date("2026-06-26T19:00:00Z") });
    expect(later.startOfDayEquity).toBe(20000);
    // 20000 → 18400 = $1600 loss > $1500 daily limit → breach (drawdown not hit: 8% < 20%).
    const breach = recordAndEvaluateDrawdownBreaker({ ...acct, equity: 18400, now: new Date("2026-06-26T20:00:00Z") });
    expect(breach.breached).toBe(true);
    expect(breach.reason).toContain("daily-loss");
    // New day → SOD re-seeds to that day's first observed equity.
    const nextDay = recordAndEvaluateDrawdownBreaker({ ...acct, equity: 18400, now: new Date("2026-06-27T14:30:00Z") });
    expect(nextDay.startOfDayEquity).toBe(18400);
  });

  it("is scoped per (account, source) — independent HWM/SOD", async () => {
    const { recordAndEvaluateDrawdownBreaker } = await import("../src/lib/risk-breaker");
    recordAndEvaluateDrawdownBreaker({ ...base, accountNumber: "ACCT-A", equity: 50000, now: new Date("2026-06-26T14:00:00Z") });
    const b = recordAndEvaluateDrawdownBreaker({ ...base, accountNumber: "ACCT-B", equity: 1000, now: new Date("2026-06-26T14:00:00Z") });
    expect(b.highWaterMark).toBe(1000); // ACCT-B is independent of ACCT-A's 50000 peak
    // Same account, different source is also independent.
    const live = recordAndEvaluateDrawdownBreaker({ ...base, accountNumber: "ACCT-A", source: "live", equity: 2000, now: new Date("2026-06-26T14:00:00Z") });
    expect(live.highWaterMark).toBe(2000);
  });

  it("is a no-op (never breaches) when the account configured no circuit-breaker limits", async () => {
    const { recordAndEvaluateDrawdownBreaker } = await import("../src/lib/risk-breaker");
    const r = recordAndEvaluateDrawdownBreaker({ accountNumber: "ACCT-NOLIMIT", source: "paper", equity: 100, riskRules: {}, userId: "local", now: new Date("2026-06-26T14:00:00Z") });
    expect(r.breached).toBe(false); // huge drop from no prior HWM, but no limits configured
  });
});
