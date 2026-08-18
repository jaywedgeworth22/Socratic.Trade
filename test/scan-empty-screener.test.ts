import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { getPolicy, resetDbForTesting, setPolicy, upsertConnectedAccount } from "../src/lib/db";
import { clearMarketCache, scanMarket, ScanQuotesUnavailableError } from "../src/lib/market";
import { AUTHENTICATED_EMAIL_HEADER, resolveRequestUserFromEmail } from "../src/lib/request-user";
import { marketScanQuotesFromAudit } from "../src/lib/scan-singleflight";
import { GET as scanGet } from "../app/api/scan/route";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-scan-empty-screener-${randomUUID()}.db`)}`;
  resetDbForTesting();
});

beforeEach(() => {
  clearMarketCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("empty screener + expired seed", () => {
  it("throws instead of returning an empty candidate table when live quotes and seed are gone", async () => {
    stubFetches({ nasdaqRows: [], yahoo: "miss" });

    await expect(scanMarket(["AAPL", "MSFT"], [])).rejects.toMatchObject({
      name: "ScanQuotesUnavailableError",
      scannedSymbols: 2,
      returnedQuotes: 0
    });
    await expect(scanMarket(["AAPL"], [])).rejects.toBeInstanceOf(ScanQuotesUnavailableError);
  });

  it("Yahoo-fallbacks the whole allowed set, including index members, when the screener is empty", async () => {
    stubFetches({ nasdaqRows: [], yahoo: "aapl" });

    const scan = await scanMarket(["AAPL"], []);
    expect(scan.returnedQuotes).toBe(1);
    expect(scan.topCandidates.map((quote) => quote.symbol)).toEqual(["AAPL"]);
    expect(scan.quotesBySymbol.AAPL?.price).toBe(210.5);
    expect(scan.source).toContain("yahoo-finance");
    expect(scan.warnings.join(" ")).toMatch(/quote fallback priced 1 of 1/);
  });

  it("keeps a fresh audit seed when the screener and quote fallback both miss", async () => {
    stubFetches({ nasdaqRows: [], yahoo: "miss" });

    const scan = await scanMarket(["AAPL"], [], undefined, undefined, [], {
      seedEnrichment: {
        AAPL: {
          symbol: "AAPL",
          price: 91,
          score: 44,
          peRatio: 15,
          intradayChangePct: -1,
          volume: 50_000
        }
      }
    });

    expect(scan.topCandidates[0]).toMatchObject({
      symbol: "AAPL",
      price: 91,
      provider: "persisted-strategy-scan"
    });
    expect(scan.warnings.join(" ")).toContain("stale fallback");
  });

  it("returns a 200 empty scan with a universe warning when nothing is allowed", async () => {
    stubFetches({ nasdaqRows: [], yahoo: "miss" });

    const scan = await scanMarket([], []);
    expect(scan.topCandidates).toEqual([]);
    expect(scan.returnedQuotes).toBe(0);
    expect(scan.warnings.join(" ")).toMatch(/universe has no symbols/i);
  });

  it("treats an expired audit seed as missing and still refuses a silent empty table", async () => {
    const quotes = { AAPL: { symbol: "AAPL", price: 90, score: 42 } };
    const expired = marketScanQuotesFromAudit(
      { scan: { quotesBySymbol: quotes } },
      "2026-06-12T16:00:00.000Z",
      Date.parse("2026-06-16T16:00:00.000Z")
    );
    expect(expired).toBeUndefined();

    stubFetches({ nasdaqRows: [], yahoo: "miss" });
    await expect(scanMarket(["AAPL"], [], undefined, undefined, [], {
      seedEnrichment: expired
    })).rejects.toBeInstanceOf(ScanQuotesUnavailableError);
  });
});

describe("GET /api/scan empty-screener contract", () => {
  it("returns 503 with a structured error, not 200 empty topCandidates", async () => {
    stubFetches({ nasdaqRows: [], yahoo: "miss" });
    const { userId } = resolveRequestUserFromEmail("scan-empty@example.com");
    upsertConnectedAccount({
      id: `scan-empty-${userId}`,
      userId,
      broker: "test",
      environment: "paper",
      accountNumber: "TEST",
      label: "Scan empty test",
      isActive: true
    });
    const policy = getPolicy(userId);
    setPolicy({
      ...policy,
      includedIndices: [],
      additionalSymbols: ["AAPL"],
      blocklist: []
    }, userId);

    const res = await scanGet(
      new Request("https://trading.example.com/api/scan", {
        headers: { [AUTHENTICATED_EMAIL_HEADER]: "scan-empty@example.com" }
      })
    );
    expect(res).toBeInstanceOf(NextResponse);
    expect(res.status).toBe(503);
    const body = await res.json() as {
      error?: string;
      code?: string;
      scannedSymbols?: number;
      returnedQuotes?: number;
      topCandidates?: unknown[];
    };
    expect(body.code).toBe("scan_quotes_unavailable");
    expect(body.returnedQuotes).toBe(0);
    expect(body.scannedSymbols).toBeGreaterThan(0);
    expect(body.topCandidates).toEqual([]);
    expect(body.error).toMatch(/Quotes were unavailable/);
  });
});

function stubFetches(input: { nasdaqRows: unknown[]; yahoo: "miss" | "aapl" }): void {
  vi.stubGlobal("fetch", async (request: RequestInfo | URL) => {
    const url = String(request);
    if (url.includes("api.nasdaq.com")) {
      return new Response(
        JSON.stringify({ data: { asof: "2026-08-18", table: { rows: input.nasdaqRows } } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (input.yahoo === "aapl" && (url.includes("/v7/finance/quote") || url.includes("/v8/finance/chart/AAPL"))) {
      if (url.includes("/v7/finance/quote")) {
        return new Response(
          JSON.stringify({
            quoteResponse: {
              result: [{
                symbol: "AAPL",
                regularMarketPrice: 210.5,
                regularMarketPreviousClose: 208,
                regularMarketVolume: 1_000_000,
                bid: 210.4,
                ask: 210.6
              }]
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          chart: {
            result: [{
              meta: { regularMarketPrice: 210.5, chartPreviousClose: 208, regularMarketVolume: 1_000_000 },
              indicators: { quote: [{ volume: [1_000_000] }] }
            }]
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("not found", { status: 404 });
  });
}
