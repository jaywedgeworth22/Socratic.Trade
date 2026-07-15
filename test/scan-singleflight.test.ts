import { afterEach, describe, expect, it } from "vitest";
import {
  marketScanQuotesFromAudit,
  resetScanSingleFlightForTests,
  runScanSingleFlight
} from "../src/lib/scan-singleflight";
import type { MarketScan } from "../src/lib/types";

function scan(generatedAt: string): MarketScan {
  return {
    source: "test",
    generatedAt,
    scannedSymbols: 0,
    returnedQuotes: 0,
    candidateLimit: 10,
    outlierReserve: 0,
    outlierCandidateCount: 0,
    topCandidates: [],
    sectorBySymbol: {},
    quotesBySymbol: {},
    cacheTtlMs: 1_000,
    cached: false,
    warnings: []
  };
}

afterEach(() => resetScanSingleFlightForTests());

describe("interactive scan single-flight", () => {
  it("shares concurrent work for the same scan key and clears after settlement", async () => {
    let calls = 0;
    let release!: (value: MarketScan) => void;
    const deferred = new Promise<MarketScan>((resolve) => { release = resolve; });
    const factory = () => {
      calls += 1;
      return deferred;
    };

    const first = runScanSingleFlight("same", factory);
    const second = runScanSingleFlight("same", factory);
    expect(first).toBe(second);
    expect(calls).toBe(0);

    await Promise.resolve();
    expect(calls).toBe(1);
    release(scan("2026-07-15T00:00:00.000Z"));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);

    await Promise.resolve();
    const third = runScanSingleFlight("same", async () => {
      calls += 1;
      return scan("2026-07-15T00:01:00.000Z");
    });
    await expect(third).resolves.toMatchObject({ generatedAt: "2026-07-15T00:01:00.000Z" });
    expect(calls).toBe(2);
  });

  it("does not coalesce different users or policy scopes", async () => {
    let calls = 0;
    const factory = async () => {
      calls += 1;
      return scan(String(calls));
    };
    await Promise.all([
      runScanSingleFlight("user-a", factory),
      runScanSingleFlight("user-b", factory)
    ]);
    expect(calls).toBe(2);
  });

  it("accepts only a full persisted strategy quote map", () => {
    const quotes = {
      FAST: { symbol: "FAST", price: 90, score: 42, peRatio: 15 }
    };
    const recent = "2026-07-15T00:00:00.000Z";
    const now = Date.parse("2026-07-15T00:00:01.000Z");
    expect(marketScanQuotesFromAudit({ marketScan: { quotesBySymbol: quotes } }, recent, now)).toBe(quotes);
    expect(marketScanQuotesFromAudit({ marketScan: { quotesBySymbol: quotes } })).toBeUndefined();
    expect(marketScanQuotesFromAudit(
      { marketScan: { quotesBySymbol: { FAST: { sym: "FAST", px: 90 } } } },
      recent,
      now
    )).toBeUndefined();
    expect(marketScanQuotesFromAudit({ marketScan: { quotesBySymbol: {} } }, recent, now)).toBeUndefined();
    expect(marketScanQuotesFromAudit(null)).toBeUndefined();
    expect(marketScanQuotesFromAudit(
      { marketScan: { quotesBySymbol: quotes } },
      "2026-07-13T00:00:00.000Z",
      Date.parse("2026-07-15T00:00:01.000Z")
    )).toBeUndefined();
  });
});
