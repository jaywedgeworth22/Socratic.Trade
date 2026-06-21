import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { dailyExecutionStats, insertProposal, notionalInLastMinutes, startOfDayInTimeZone } from "../src/lib/db";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-daily-${randomUUID()}.db`)}`;
});

function proposal(
  id: string,
  account: string,
  side: string,
  estimatedNotional: number | undefined,
  extra: Record<string, unknown> = {},
  userId = "local"
) {
  insertProposal({
    id,
    userId,
    runId: "r1",
    accountNumber: account,
    proposal: { side, ...extra },
    decision: { approved: true, reasons: [] },
    estimatedNotional,
    status: "placed"
  });
}

describe("startOfDayInTimeZone — T13 explicit daily-reset boundary", () => {
  it("returns civil midnight of the market day regardless of the server's local TZ", () => {
    // June → America/New_York is EDT (UTC-4), so the market day starts at 04:00 UTC.
    expect(startOfDayInTimeZone(new Date("2026-06-16T12:00:00.000Z"), "America/New_York").toISOString()).toBe(
      "2026-06-16T04:00:00.000Z"
    );
    // 02:00 UTC is still the PREVIOUS calendar day in New York → previous market-day boundary.
    expect(startOfDayInTimeZone(new Date("2026-06-16T02:00:00.000Z"), "America/New_York").toISOString()).toBe(
      "2026-06-15T04:00:00.000Z"
    );
    // UTC boundary for comparison.
    expect(startOfDayInTimeZone(new Date("2026-06-16T12:00:00.000Z"), "UTC").toISOString()).toBe(
      "2026-06-16T00:00:00.000Z"
    );
  });
});

describe("daily/hourly notional accounting — T6", () => {
  it("counts opening (buy/short) notional only, but every order toward the count", () => {
    const a = "T6_SIDES";
    proposal("t6-buy", a, "buy", 1000);
    proposal("t6-short", a, "short", 500);
    proposal("t6-sell", a, "sell", 800);
    proposal("t6-cover", a, "cover", 300);

    const daily = dailyExecutionStats(a);
    expect(daily.notional).toBeCloseTo(1500); // 1000 buy + 500 short; sell/cover do not add notional
    expect(daily.orderCount).toBe(4); // every placed order counts toward the order cap

    const hourly = notionalInLastMinutes(a, 60);
    expect(hourly.notional).toBeCloseTo(1500); // same side-awareness on the rolling hourly window
    expect(hourly.orderCount).toBe(4);
  });

  it("scopes notional by user (tenant isolation)", () => {
    const a = "T6_TENANT";
    proposal("t6-ua", a, "buy", 1000, {}, "user-a");
    proposal("t6-ub", a, "buy", 4000, {}, "user-b");

    expect(dailyExecutionStats(a, new Date(), "user-a").notional).toBeCloseTo(1000);
    expect(dailyExecutionStats(a, new Date(), "user-b").notional).toBeCloseTo(4000);
    expect(notionalInLastMinutes(a, 60, new Date(), "user-a").notional).toBeCloseTo(1000);
  });

  it("falls back to proposal fields when estimated_notional is null", () => {
    const a = "T6_FALLBACK";
    proposal("t6-fb-dollar", a, "buy", undefined, { dollarAmount: 700 });
    proposal("t6-fb-qty", a, "buy", undefined, { quantity: 3, limitPrice: 100 });

    expect(dailyExecutionStats(a).notional).toBeCloseTo(1000); // 700 (dollarAmount) + 300 (3 * 100)
  });
});
