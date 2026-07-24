import { describe, expect, it } from "vitest";
import { DEFAULT_VISIBLE_SCAN_COLUMN_IDS } from "../app/console/scan/columns";
import { moveVisibleScanColumn, sanitizeVisibleScanColumns, toggleVisibleScanColumn } from "../app/console/scan/scan-table";

describe("scan-table column state", () => {
  it("falls back to the default visible columns when saved state is invalid", () => {
    expect(sanitizeVisibleScanColumns(null)).toEqual(DEFAULT_VISIBLE_SCAN_COLUMN_IDS);
    expect(sanitizeVisibleScanColumns({ bad: true })).toEqual(DEFAULT_VISIBLE_SCAN_COLUMN_IDS);
    expect(sanitizeVisibleScanColumns([])).toEqual(DEFAULT_VISIBLE_SCAN_COLUMN_IDS);
  });

  it("keeps only valid unique ids and restores symbol if a saved payload dropped it", () => {
    expect(sanitizeVisibleScanColumns(["price", "bogus", "price", "score"])).toEqual(["symbol", "price", "score"]);
    expect(sanitizeVisibleScanColumns(["price", "symbol", "score"])).toEqual(["symbol", "price", "score"]);
  });

  it("toggles non-symbol columns without allowing symbol to disappear", () => {
    expect(toggleVisibleScanColumn(["symbol", "score", "price"], "price")).toEqual(["symbol", "score"]);
    expect(toggleVisibleScanColumn(["symbol", "score"], "price")).toEqual(["symbol", "score", "price"]);
    expect(toggleVisibleScanColumn(["symbol", "score"], "symbol")).toEqual(["symbol", "score"]);
  });

  it("moves visible columns earlier or later while clamping at the edges", () => {
    expect(moveVisibleScanColumn(["symbol", "score", "price"], "price", -1)).toEqual(["symbol", "price", "score"]);
    expect(moveVisibleScanColumn(["symbol", "score", "price"], "score", -1)).toEqual(["symbol", "score", "price"]);
    expect(moveVisibleScanColumn(["symbol", "score", "price"], "symbol", -1)).toEqual(["symbol", "score", "price"]);
    expect(moveVisibleScanColumn(["symbol", "score", "price"], "price", 1)).toEqual(["symbol", "score", "price"]);
  });

  it("assigns expected text alignments to scan columns", () => {
    const { SCAN_COLUMNS } = require("../app/console/scan/columns");
    const symbolCol = SCAN_COLUMNS.find((c: any) => c.id === "symbol");
    const priceCol = SCAN_COLUMNS.find((c: any) => c.id === "price");
    const scoreCol = SCAN_COLUMNS.find((c: any) => c.id === "score");
    const sentimentCol = SCAN_COLUMNS.find((c: any) => c.id === "sentiment");

    expect(symbolCol?.align).toBe("left");
    expect(priceCol?.align).toBe("right");
    expect(scoreCol?.align).toBe("center");
    expect(sentimentCol?.align).toBe("center");
  });

  it("falls back to insiderSentiment when news sentiment is missing", () => {
    const { SCAN_COLUMNS } = require("../app/console/scan/columns");
    const sentimentCol = SCAN_COLUMNS.find((c: any) => c.id === "sentiment");

    const quoteWithNews = { symbol: "AAPL", sentiment: 75, insiderSentiment: 60 };
    const quoteWithInsiderOnly = { symbol: "MSFT", insiderSentiment: 68 };
    const quoteWithNone = { symbol: "GOOG" };

    expect(sentimentCol?.sortValue(quoteWithNews)).toBe(75);
    expect(sentimentCol?.sortValue(quoteWithInsiderOnly)).toBe(68);
    expect(sentimentCol?.sortValue(quoteWithNone)).toBeUndefined();
  });
});
