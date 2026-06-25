import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SymbolEnrichment } from "../src/lib/data-providers";

// Mock the enrichment provider so the builders never hit the network.
vi.mock("../src/lib/data-providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/data-providers")>();
  return { ...actual, getEnrichmentProvider: vi.fn() };
});

import { getEnrichmentProvider } from "../src/lib/data-providers";
import {
  buildFundamentalsAnalystImport,
  enrichmentToAnalyst,
  enrichmentToFundamentals,
  isCongressFundamentalsShareEnabled,
  pickAnalystCounts
} from "../src/lib/congress-share";

const mockedProvider = vi.mocked(getEnrichmentProvider);

function provideEnrichment(map: Record<string, SymbolEnrichment>): void {
  mockedProvider.mockReturnValue({ name: "mock", configured: true, enrich: async () => map });
}

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-congress-fundamentals-${randomUUID()}.db`)}`;
});

beforeEach(() => {
  delete process.env.CONGRESS_SHARE_FUNDAMENTALS;
  delete process.env.CONGRESS_SHARE_FUNDAMENTALS_MAX;
  mockedProvider.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── pure mappers ────────────────────────────────────────────────────────────────

describe("pickAnalystCounts", () => {
  it("picks the source with the most complete counts (no cross-source summing)", () => {
    const counts = pickAnalystCounts({
      analystBySource: {
        finnhub: { score: 70, label: "Buy", counts: { strongBuy: 1, buy: 1, hold: 0, sell: 0, strongSell: 0 } },
        fmp: { score: 80, label: "Buy", counts: { strongBuy: 5, buy: 10, hold: 3, sell: 1, strongSell: 0 } }
      }
    });
    expect(counts).toEqual({ strongBuy: 5, buy: 10, hold: 3, sell: 1, strongSell: 0 });
  });

  it("returns null when no source reports counts", () => {
    expect(pickAnalystCounts({ analystBySource: { x: { score: 50, label: "Hold" } } })).toBeNull();
    expect(pickAnalystCounts({})).toBeNull();
  });
});

describe("enrichmentToFundamentals", () => {
  it("maps fields and uses the week52High/Low spelling", () => {
    const f = enrichmentToFundamentals("aapl", "2026-06-25", {
      peRatio: 30, eps: 6.5, dividendYield: 0.5, fcfYield: 3.2, debtToEquity: 1.1,
      epsGrowth: 12, fiftyTwoWeekHigh: 210, fiftyTwoWeekLow: 150, beta: 1.2
    });
    expect(f).toEqual({
      ticker: "AAPL", date: "2026-06-25", peRatio: 30, eps: 6.5, dividendYield: 0.5,
      fcfYield: 3.2, debtToEquity: 1.1, epsGrowth: 12, week52High: 210, week52Low: 150, beta: 1.2
    });
  });

  it("returns null when there are no fundamentals at all", () => {
    expect(enrichmentToFundamentals("AAPL", "2026-06-25", { sentiment: 60 })).toBeNull();
  });
});

describe("enrichmentToAnalyst", () => {
  it("emits counts + rating with null price targets by default", () => {
    const a = enrichmentToAnalyst("msft", "2026-06-25", {
      analystRating: "Buy",
      analystBySource: { fmp: { score: 80, label: "Buy", counts: { strongBuy: 5, buy: 10, hold: 3, sell: 1, strongSell: 0 } } }
    });
    expect(a).toEqual({
      ticker: "MSFT", date: "2026-06-25", rating: "Buy",
      strongBuy: 5, buy: 10, hold: 3, sell: 1, strongSell: 0, analystCount: 19,
      targetMean: null, targetHigh: null, targetLow: null, targetMedian: null
    });
  });

  it("fills numeric price targets when the enrichment carries them", () => {
    const a = enrichmentToAnalyst("NVDA", "2026-06-25", {
      analystRating: "Strong Buy",
      targetMean: 130, targetHigh: 160, targetLow: 100, targetMedian: 128
    });
    expect(a).toMatchObject({ rating: "Strong Buy", analystCount: 0, targetMean: 130, targetHigh: 160, targetLow: 100, targetMedian: 128 });
  });

  it("returns null when neither rating nor counts exist", () => {
    expect(enrichmentToAnalyst("AAPL", "2026-06-25", { peRatio: 20 })).toBeNull();
  });
});

// ── builder gating + mapping ─────────────────────────────────────────────────────

describe("buildFundamentalsAnalystImport", () => {
  it("returns empty and does NOT enrich when disabled (default)", async () => {
    provideEnrichment({ AAPL: { peRatio: 30 } });
    const out = await buildFundamentalsAnalystImport(["AAPL"]);
    expect(out).toEqual({ fundamentals: [], analyst: [], enriched: 0, cappedFrom: 0 });
    expect(mockedProvider).not.toHaveBeenCalled();
  });

  it("enriches and maps when CONGRESS_SHARE_FUNDAMENTALS is on", async () => {
    process.env.CONGRESS_SHARE_FUNDAMENTALS = "1";
    expect(isCongressFundamentalsShareEnabled()).toBe(true);
    provideEnrichment({
      AAPL: { asOf: "2026-06-24T20:00:00Z", peRatio: 30, eps: 6.5, analystRating: "Buy", analystBySource: { fmp: { score: 80, label: "Buy", counts: { strongBuy: 5, buy: 10, hold: 3, sell: 1, strongSell: 0 } } } },
      MSFT: { peRatio: 35 }
    });
    const out = await buildFundamentalsAnalystImport(["aapl", "msft"], Date.UTC(2026, 5, 25));
    expect(out.enriched).toBe(2);
    expect(out.fundamentals.map((f) => f.ticker).sort()).toEqual(["AAPL", "MSFT"]);
    const aapl = out.fundamentals.find((f) => f.ticker === "AAPL")!;
    expect(aapl.date).toBe("2026-06-24"); // from asOf
    expect(out.analyst).toHaveLength(1); // only AAPL has rating/counts
    expect(out.analyst[0]).toMatchObject({ ticker: "AAPL", analystCount: 19 });
  });

  it("caps the universe at CONGRESS_SHARE_FUNDAMENTALS_MAX and reports cappedFrom", async () => {
    process.env.CONGRESS_SHARE_FUNDAMENTALS = "1";
    process.env.CONGRESS_SHARE_FUNDAMENTALS_MAX = "2";
    const enrichSpy = vi.fn(async (syms: string[]) => Object.fromEntries(syms.map((s) => [s, { peRatio: 10 }])));
    mockedProvider.mockReturnValue({ name: "mock", configured: true, enrich: enrichSpy });
    const out = await buildFundamentalsAnalystImport(["A", "B", "C", "D"]);
    expect(enrichSpy).toHaveBeenCalledWith(["A", "B"]); // capped to 2
    expect(out.enriched).toBe(2);
    expect(out.cappedFrom).toBe(4);
  });
});
