import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { getTaxSummary, getWashSaleLockedSymbols, getWashSaleLockedSymbolsForUser } from "../src/lib/tax";
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

describe("tax — T12 long-only for short/cover", () => {
  it("excludes a short/cover round-trip from realized tax (long-only)", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const a = "TAX_SHORT_ONLY";
    const base = { proposalId: "p1", runId: "r1", source: "paper" as const, status: "filled", raw: undefined, accountNumber: a, symbol: "TSLA" };
    // Profitable short within the year: short @100 (20d ago), cover @80 (10d ago) → +$20 on a SHORT lot.
    insertFillEvent({ ...base, id: "t12-s1", side: "short", quantity: 1, price: 100, notional: 100, filledAt: daysAgo(20) });
    insertFillEvent({ ...base, id: "t12-s2", side: "cover", quantity: 1, price: 80, notional: 80, filledAt: daysAgo(10) });

    const summary = getTaxSummary(a, "paper", {}, undefined, NOW);
    expect(summary.shortTermRealized).toBeCloseTo(0); // short/cover lots are not `long` → never taxed
    expect(summary.longTermRealized).toBeCloseTo(0);
  });

  it("still counts an equivalent long round-trip (control)", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const a = "TAX_LONG_CTRL";
    const base = { proposalId: "p1", runId: "r1", source: "paper" as const, status: "filled", raw: undefined, accountNumber: a, symbol: "AAPL" };
    insertFillEvent({ ...base, id: "t12-l1", side: "buy", quantity: 1, price: 100, notional: 100, filledAt: daysAgo(20) });
    insertFillEvent({ ...base, id: "t12-l2", side: "sell", quantity: 1, price: 130, notional: 130, filledAt: daysAgo(10) });

    const summary = getTaxSummary(a, "paper", {}, undefined, NOW);
    expect(summary.shortTermRealized).toBeCloseTo(30); // long round-trip IS taxed
  });
});

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

  it("treats an IRA as tax-sheltered: 0% rates, no estimated tax, and no own-account wash-sale lockout", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const a = "IRA1";
    // A short-term gain that WOULD be taxed in a taxable account (+$30).
    insertFillEvent(fill({ id: "i1", side: "buy", quantity: 1, price: 100, notional: 100, accountNumber: a, symbol: "AMD", filledAt: daysAgo(20) }));
    insertFillEvent(fill({ id: "i2", side: "sell", quantity: 1, price: 130, notional: 130, accountNumber: a, symbol: "AMD", filledAt: daysAgo(5) }));
    // A loss sale within 30 days that WOULD lock in a taxable account.
    insertFillEvent(fill({ id: "i3", side: "buy", quantity: 1, price: 100, notional: 100, accountNumber: a, symbol: "INTC", filledAt: daysAgo(40) }));
    insertFillEvent(fill({ id: "i4", side: "sell", quantity: 1, price: 90, notional: 90, accountNumber: a, symbol: "INTC", filledAt: daysAgo(10) }));

    const tax = getTaxSummary(a, "paper", {}, { taxationType: "roth_ira" }, NOW);
    expect(tax.settings.shortTermRatePct).toBe(0);
    expect(tax.settings.longTermRatePct).toBe(0);
    expect(tax.settings.washSaleGuard).toBe(false);
    expect(tax.estimatedTaxLiability).toBeCloseTo(0);
    // IRA bypasses its own wash-sale lockout (a wash sale has no benefit inside the IRA).
    expect(tax.lockedSymbols).not.toContain("INTC");
  });

  it("locks a symbol across ALL accounts (incl. IRA) when the loss is realized in a TAXABLE account", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const taxable = "XACCT-TAXABLE";
    const ira = "XACCT-IRA";
    insertFillEvent(fill({ id: "x1", side: "buy", quantity: 1, price: 100, notional: 100, accountNumber: taxable, symbol: "TSLA", filledAt: daysAgo(40) }));
    insertFillEvent(fill({ id: "x2", side: "sell", quantity: 1, price: 90, notional: 90, accountNumber: taxable, symbol: "TSLA", filledAt: daysAgo(8) }));

    const locked = getWashSaleLockedSymbolsForUser(
      [
        { accountNumber: taxable, source: "paper", taxationType: "taxable" },
        { accountNumber: ira, source: "paper", taxationType: "roth_ira" }
      ],
      NOW
    );
    // The taxable-account loss locks TSLA rebuys everywhere, including the IRA (Rev. Rul. 2008-5).
    expect(locked.has("TSLA")).toBe(true);
  });

  it("does NOT create a cross-account lockout from a loss realized inside an IRA", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const ira = "IRA-ONLYLOSS";
    insertFillEvent(fill({ id: "y1", side: "buy", quantity: 1, price: 100, notional: 100, accountNumber: ira, symbol: "BABA", filledAt: daysAgo(40) }));
    insertFillEvent(fill({ id: "y2", side: "sell", quantity: 1, price: 90, notional: 90, accountNumber: ira, symbol: "BABA", filledAt: daysAgo(8) }));

    const locked = getWashSaleLockedSymbolsForUser(
      [{ accountNumber: ira, source: "paper", taxationType: "traditional_ira" }],
      NOW
    );
    expect(locked.has("BABA")).toBe(false);
  });
});
