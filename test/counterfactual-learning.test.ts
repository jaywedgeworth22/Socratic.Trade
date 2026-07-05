import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { materializeSkippedCandidateCounterfactuals, type CounterfactualOHLCFetcher } from "../src/lib/counterfactual-learning";
import { audit, listMaturedSkippedCounterfactuals } from "../src/lib/db";
import { getSkippedCandidateReturns } from "../src/lib/performance";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-counterfactual-${randomUUID()}.db`)}`;
});

const momentumBreakdown = {
  liquidity: 20,
  momentum: 95,
  value: 30,
  quality: 25,
  volatility: 15,
  sentiment: 40,
  positioning: 35,
  diversification: 10,
  weightedTotal: 76
};

describe("counterfactual skipped-candidate learning", () => {
  it("materializes mature skipped returns idempotently from signal_snapshot evidence", async () => {
    const userId = `cf-idem-${randomUUID()}`;
    // 2026-06-10 is a Wednesday; 5 TRADING days later (Thu/Fri/Mon/Tue/Wed, no holidays in
    // between) lands on 2026-06-17 — NOT the calendar-day "2026-06-15" this fixture used
    // before the trading-day-horizon fix (see docs/rollouts/2026-07-04-w1-learning-loops.md).
    const fetchOHLC: CounterfactualOHLCFetcher = async () => [
      { time: "2026-06-10", close: 100 },
      { time: "2026-06-17", close: 115 }
    ];

    audit("signal_snapshot", {
      runId: "run-cf-idem",
      asOf: "2026-06-10T14:30:00.000Z",
      signals: [
        {
          symbol: "AAPL",
          chosen: false,
          refPrice: 100,
          score: 88,
          sector: "Technology",
          regime: "Risk-On",
          factorBreakdown: momentumBreakdown,
          bulletins: ["AAPL had a bullish technical setup."]
        },
        { symbol: "MSFT", chosen: true, refPrice: 50, score: 90 }
      ]
    }, userId);

    const first = await materializeSkippedCandidateCounterfactuals(userId, {
      now: Date.parse("2026-06-20T00:00:00.000Z"),
      horizonDays: 5,
      fetchOHLC
    });
    const second = await materializeSkippedCandidateCounterfactuals(userId, {
      now: Date.parse("2026-06-20T00:00:00.000Z"),
      horizonDays: 5,
      fetchOHLC
    });

    expect(first).toMatchObject({ auditRowsScanned: 1, candidatesInserted: 1, pendingChecked: 1, materialized: 1 });
    expect(second).toMatchObject({ auditRowsScanned: 0, candidatesInserted: 0, pendingChecked: 0, materialized: 0 });

    const rows = listMaturedSkippedCounterfactuals(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runId: "run-cf-idem",
      symbol: "AAPL",
      refPrice: 100,
      exitDate: "2026-06-17",
      exitPrice: 115,
      returnPct: 15,
      dominantFactor: "momentum"
    });

    const promptRows = getSkippedCandidateReturns({}, userId, { maxAgeDays: 10_000 });
    expect(promptRows).toHaveLength(1);
    expect(promptRows[0]).toMatchObject({ symbol: "AAPL", returnPct: 15, currentPrice: 115 });
  });

  it("keeps materialization scoped by user even for the same run and symbol", async () => {
    const userA = `cf-user-a-${randomUUID()}`;
    const userB = `cf-user-b-${randomUUID()}`;
    const calls: string[] = [];
    // 5 TRADING days after Wed 2026-06-10 lands on 2026-06-17 (see the fixture above).
    const fetchOHLC: CounterfactualOHLCFetcher = async (symbol, _now, userId) => {
      calls.push(`${userId}:${symbol}`);
      return [
        { time: "2026-06-10", close: 70 },
        { time: "2026-06-17", close: 80 }
      ];
    };

    audit("signal_snapshot", {
      runId: "run-cf-users",
      asOf: "2026-06-10T14:30:00.000Z",
      signals: [{ symbol: "NVDA", chosen: false, refPrice: 100, score: 80, regime: "Risk-On" }]
    }, userA);
    audit("signal_snapshot", {
      runId: "run-cf-users",
      asOf: "2026-06-10T14:30:00.000Z",
      signals: [{ symbol: "NVDA", chosen: false, refPrice: 50, score: 80, regime: "Risk-On" }]
    }, userB);

    await materializeSkippedCandidateCounterfactuals(userA, {
      now: Date.parse("2026-06-20T00:00:00.000Z"),
      horizonDays: 5,
      fetchOHLC
    });

    expect(listMaturedSkippedCounterfactuals(userA)).toHaveLength(1);
    expect(listMaturedSkippedCounterfactuals(userB)).toHaveLength(0);

    await materializeSkippedCandidateCounterfactuals(userB, {
      now: Date.parse("2026-06-20T00:00:00.000Z"),
      horizonDays: 5,
      fetchOHLC
    });

    const rowA = listMaturedSkippedCounterfactuals(userA)[0];
    const rowB = listMaturedSkippedCounterfactuals(userB)[0];
    expect(rowA.returnPct).toBe(-20);
    expect(rowB.returnPct).toBe(60);
    // The materializer now also fetches one SPY series per run (for the multi-horizon rows'
    // SPY-relative excess) before the per-candidate fetches.
    expect(calls).toEqual([`${userA}:SPY`, `${userA}:NVDA`, `${userB}:SPY`, `${userB}:NVDA`]);
  });
});
