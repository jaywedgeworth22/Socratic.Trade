import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { getPolicy, latestAuditByKind, resetDbForTesting, setPolicy, upsertConnectedAccount } from "../src/lib/db";
import { isUnusableEmptyMarketScan } from "../src/lib/scan-singleflight";
import { clearMarketCache, scanMarket, ScanQuotesUnavailableError } from "../src/lib/market";
import { AUTHENTICATED_EMAIL_HEADER, resolveRequestUserFromEmail } from "../src/lib/request-user";
import { BROWSER_UA } from "../src/lib/web-sources/http";
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

    const scan = await scanMarket(["AAPL"], [], undefined, undefined, [], { enrichmentMode: "skip" });
    expect(scan.returnedQuotes).toBe(1);
    expect(scan.topCandidates.map((quote) => quote.symbol)).toEqual(["AAPL"]);
    expect(scan.quotesBySymbol.AAPL?.price).toBe(210.5);
    expect(scan.source).toContain("yahoo-finance");
    expect(scan.warnings.join(" ")).toMatch(/quote fallback priced 1 of 1/);
  });

  it("keeps a fresh audit seed when the screener and quote fallback both miss", async () => {
    stubFetches({ nasdaqRows: [], yahoo: "miss" });

    const scan = await scanMarket(["AAPL"], [], undefined, undefined, [], {
      enrichmentMode: "skip",
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

  it("does not treat a 505-symbol abort as an empty universe or last-good", () => {
    expect(isUnusableEmptyMarketScan({
      scannedSymbols: 505,
      returnedQuotes: 0,
      topCandidates: [],
      quotesBySymbol: {}
    })).toBe(true);
    expect(isUnusableEmptyMarketScan({
      scannedSymbols: 0,
      returnedQuotes: 0,
      topCandidates: []
    })).toBe(false);
    expect(isUnusableEmptyMarketScan({
      scannedSymbols: 515,
      returnedQuotes: 513,
      topCandidates: [{ symbol: "AAPL" }]
    })).toBe(false);
  });

  it("throws on Nasdaq abort + empty seed for a non-empty universe, not 200 empty", async () => {
    const universe = ["AAPL", "MSFT", "NVDA", "XOM", "JPM"];
    stubFetches({ nasdaqRows: [], yahoo: "miss", nasdaqAbort: true });

    await expect(scanMarket(universe, [], undefined, undefined, [], { enrichmentMode: "skip" })).rejects.toMatchObject({
      name: "ScanQuotesUnavailableError",
      scannedSymbols: 5,
      returnedQuotes: 0
    });
    try {
      await scanMarket(universe, [], undefined, undefined, [], { enrichmentMode: "skip" });
      throw new Error("expected ScanQuotesUnavailableError");
    } catch (error) {
      expect(error).toBeInstanceOf(ScanQuotesUnavailableError);
      const unavailable = error as ScanQuotesUnavailableError;
      expect(unavailable.scannedSymbols).toBe(5);
      expect(unavailable.warnings.join(" ")).toMatch(/aborted/i);
      expect(unavailable.warnings.join(" ")).not.toMatch(/universe has no symbols/i);
      expect(unavailable.warnings.join(" ")).not.toMatch(/Guardrails/i);
      expect(unavailable.message).not.toMatch(/Guardrails/i);
    }
  });

  it("Yahoo-fallbacks the whole allowed set after a Nasdaq abort", async () => {
    stubFetches({ nasdaqRows: [], yahoo: "aapl", nasdaqAbort: true });

    const scan = await scanMarket(["AAPL"], [], undefined, undefined, [], { enrichmentMode: "skip" });
    expect(scan.returnedQuotes).toBe(1);
    expect(scan.topCandidates.map((quote) => quote.symbol)).toEqual(["AAPL"]);
    expect(scan.source).toContain("yahoo-finance");
    expect(scan.warnings.join(" ")).toMatch(/aborted/i);
    expect(scan.warnings.join(" ")).toMatch(/quote fallback priced 1 of 1/);
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

describe("fetchNasdaqScreener transport", () => {
  it("uses BROWSER_UA and fetchWithRetry headers, not the stub Mozilla/5.0 UA", async () => {
    const seen: Array<{ url: string; userAgent: string | null; origin: string | null; referer: string | null }> = [];
    vi.stubGlobal("fetch", async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request);
      const headers = new Headers(init?.headers);
      if (url.includes("api.nasdaq.com")) {
        seen.push({
          url,
          userAgent: headers.get("user-agent") ?? headers.get("User-Agent"),
          origin: headers.get("origin") ?? headers.get("Origin"),
          referer: headers.get("referer") ?? headers.get("Referer")
        });
        return new Response(
          JSON.stringify({
            data: {
              asof: "2026-08-18",
              table: {
                rows: [{
                  symbol: "AAPL",
                  name: "Apple Inc",
                  lastsale: "$210.50",
                  netchange: "2.5",
                  pctchange: "1.2%",
                  marketCap: "3000000000000",
                  volume: "1000000",
                  sector: "Technology",
                  industry: "Consumer Electronics"
                }]
              }
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("not found", { status: 404 });
    });

    const scan = await scanMarket(["AAPL"], [], undefined, undefined, [], { enrichmentMode: "skip" });
    expect(scan.topCandidates.map((quote) => quote.symbol)).toEqual(["AAPL"]);
    expect(scan.returnedQuotes).toBeGreaterThan(0);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]?.userAgent).toBe(BROWSER_UA);
    expect(seen[0]?.userAgent).not.toBe("Mozilla/5.0");
    expect(seen[0]?.origin).toBe("https://www.nasdaq.com");
    expect(seen[0]?.referer).toBe("https://www.nasdaq.com/");
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
    expect(body.error).not.toMatch(/Guardrails/);
    const failed = latestAuditByKind("market_scan_failed", userId);
    expect(failed).toBeTruthy();
    expect(latestAuditByKind("market_scan", userId)).toBeUndefined();
  });

  it("writes market_scan_failed on Nasdaq abort, not a silent market_scan", async () => {
    stubFetches({ nasdaqRows: [], yahoo: "miss", nasdaqAbort: true });
    const { userId } = resolveRequestUserFromEmail("scan-abort@example.com");
    upsertConnectedAccount({
      id: `scan-abort-${userId}`,
      userId,
      broker: "test",
      environment: "paper",
      accountNumber: "TEST",
      label: "Scan abort test",
      isActive: true
    });
    const policy = getPolicy(userId);
    setPolicy({
      ...policy,
      includedIndices: [],
      additionalSymbols: ["AAPL", "MSFT", "NVDA", "XOM", "SPCX"],
      blocklist: []
    }, userId);

    const res = await scanGet(
      new Request("https://trading.example.com/api/scan", {
        headers: { [AUTHENTICATED_EMAIL_HEADER]: "scan-abort@example.com" }
      })
    );
    expect(res.status).toBe(503);
    const body = await res.json() as { warnings?: string[]; scannedSymbols?: number };
    expect(body.scannedSymbols).toBe(5);
    expect(body.warnings?.join(" ") ?? "").toMatch(/aborted/i);
    expect(body.warnings?.join(" ") ?? "").not.toMatch(/universe has no symbols/i);
    expect(latestAuditByKind("market_scan_failed", userId)?.kind).toBe("market_scan_failed");
    expect(latestAuditByKind("market_scan", userId)).toBeUndefined();
  });
});

function stubFetches(input: { nasdaqRows: unknown[]; yahoo: "miss" | "aapl"; nasdaqAbort?: boolean }): void {
  vi.stubGlobal("fetch", async (request: RequestInfo | URL) => {
    const url = String(request);
    if (url.includes("api.nasdaq.com")) {
      if (input.nasdaqAbort) {
        const error = new Error("This operation was aborted");
        error.name = "AbortError";
        throw error;
      }
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
