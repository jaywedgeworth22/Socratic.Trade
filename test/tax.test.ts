import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { getTaxSummary, getWashSaleLockedSymbols } from "../src/lib/tax";
import type { FillEvent } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-tax-${randomUUID()}.db`)}`;
});

const NOW = new Date("2026-06-16T12:00:00.000Z");
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();

function fill(input: Partial<FillEvent> & { id: string; side: "buy" | "sell"; quantity: number; price: number; notional: number; filledAt: string; accountNumber: string; symbol: string }): FillEvent {
  return { proposalId: "p1", runId: "r1", source: "paper", status: "filled", raw: undefined, ...input };
}

describe("tax", () => {
  it("locks a symbol sold at a loss within 30 days and flags the wash sale", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const a = "TAXWASH";
    // Buy 40d ago @100, sell 10d ago @90 (-$10 short-term loss), rebuy 5d ago @92 (replacement -> wash sale).
    insertFillEvent(fill({ id: "w1", side: "buy", quantity: 1, price: 100, notional: 100, accountNumber: a, symbol: "AAPL", filledAt: daysAgo(40) }));
    insertFillEvent(fill({ id: "w2", side: "sell", quantity: 1, price: 90, notional: 90, accountNumber: a, symbol: "AAPL", filledAt: daysAgo(10) }));
    insertFillEvent(fill({ id: "w3", side: "buy", quantity: 1, price: 92, notional: 92, accountNumber: a, symbol: "AAPL", filledAt: daysAgo(5) }));

    const locked = getWashSaleLockedSymbols(a, "paper", NOW);
    expect(locked.has("AAPL")).toBe(true);

    const tax = getTaxSummary(a, "paper", { AAPL: 95 }, undefined, NOW);
    expect(tax.lockedSymbols).toContain("AAPL");
    expect(tax.washSales.length).toBe(1);
    expect(tax.washSales[0].disallowedLoss).toBeCloseTo(10);
    // The -$10 loss is a disallowed wash sale, so it does not reduce short-term realized.
    expect(tax.shortTermRealized).toBeCloseTo(0);
    expect(tax.disallowedWashSaleLoss).toBeCloseTo(10);
    // The 5-day-old rebuy is an open short-term lot.
    const openAapl = tax.openLots.find((l) => l.symbol === "AAPL");
    expect(openAapl?.isLongTerm).toBe(false);
    expect(openAapl?.daysToLongTerm).toBe(360);
  });

  it("classifies a >1-year gain as long-term and estimates tax at the long-term rate", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const a = "TAXLT";
    insertFillEvent(fill({ id: "l1", side: "buy", quantity: 1, price: 100, notional: 100, accountNumber: a, symbol: "MSFT", filledAt: daysAgo(400) }));
    insertFillEvent(fill({ id: "l2", side: "sell", quantity: 1, price: 130, notional: 130, accountNumber: a, symbol: "MSFT", filledAt: daysAgo(10) }));

    const tax = getTaxSummary(a, "paper", {}, { washSaleGuard: true, shortTermRatePct: 24, longTermRatePct: 15 }, NOW);
    expect(tax.longTermRealized).toBeCloseTo(30);
    expect(tax.shortTermRealized).toBeCloseTo(0);
    expect(tax.estimatedLongTermTax).toBeCloseTo(4.5); // 30 * 15%
    expect(tax.estimatedTaxLiability).toBeCloseTo(4.5);
    expect(getWashSaleLockedSymbols(a, "paper", NOW).has("MSFT")).toBe(false); // gain, not a loss
  });

  it("does not lock a loss sale older than 30 days, and keeps its loss deductible", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const a = "TAXOLD";
    insertFillEvent(fill({ id: "o1", side: "buy", quantity: 1, price: 50, notional: 50, accountNumber: a, symbol: "T", filledAt: daysAgo(90) }));
    insertFillEvent(fill({ id: "o2", side: "sell", quantity: 1, price: 45, notional: 45, accountNumber: a, symbol: "T", filledAt: daysAgo(40) }));

    expect(getWashSaleLockedSymbols(a, "paper", NOW).has("T")).toBe(false);
    const tax = getTaxSummary(a, "paper", {}, undefined, NOW);
    expect(tax.washSales.length).toBe(0);
    expect(tax.shortTermRealized).toBeCloseTo(-5); // deductible short-term loss
  });

  it("surfaces unrealized losers as tax-loss-harvest candidates", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const a = "TAXHARV";
    insertFillEvent(fill({ id: "h1", side: "buy", quantity: 2, price: 100, notional: 200, accountNumber: a, symbol: "NVDA", filledAt: daysAgo(20) }));
    const tax = getTaxSummary(a, "paper", { NVDA: 90 }, undefined, NOW); // marked down 10/share
    const cand = tax.harvestCandidates.find((c) => c.symbol === "NVDA");
    expect(cand?.unrealizedLoss).toBeCloseTo(-20);
  });
});
