import { describe, expect, it } from "vitest";
import { approvalQuoteSymbols, buildApprovalQuoteScan } from "../src/lib/approval-quote-scan";

describe("approval quote scan", () => {
  it("quotes the proposal plus held names only", () => {
    expect(
      approvalQuoteSymbols({ symbol: "t" }, [
        { symbol: "AAPL", quantity: 1, marketValue: 200, averageCost: 180 },
        { symbol: "t", quantity: 2, marketValue: 50, averageCost: 24 }
      ])
    ).toEqual(["T", "AAPL"]);
  });

  it("builds a MarketScan from cascade quotes without a full screener", () => {
    const scan = buildApprovalQuoteScan(
      {
        T: {
          symbol: "T",
          price: 25.1,
          bid: 25.09,
          ask: 25.11,
          provider: "alpaca-snapshot",
          asOf: "2026-08-16T20:00:00.000Z"
        }
      },
      []
    );
    expect(scan.source).toBe("alpaca-snapshot");
    expect(scan.scannedSymbols).toBe(1);
    expect(scan.quotesBySymbol.T?.price).toBe(25.1);
    expect(scan.topCandidates[0]?.symbol).toBe("T");
    expect(scan.warnings).toEqual([]);
  });

  it("warns when nothing priced", () => {
    const scan = buildApprovalQuoteScan({}, []);
    expect(scan.returnedQuotes).toBe(0);
    expect(scan.warnings[0]).toMatch(/No live quotes/);
  });
});
