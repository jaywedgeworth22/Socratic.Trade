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
  });

  it("toggles non-symbol columns without allowing symbol to disappear", () => {
    expect(toggleVisibleScanColumn(["symbol", "score", "price"], "price")).toEqual(["symbol", "score"]);
    expect(toggleVisibleScanColumn(["symbol", "score"], "price")).toEqual(["symbol", "score", "price"]);
    expect(toggleVisibleScanColumn(["symbol", "score"], "symbol")).toEqual(["symbol", "score"]);
  });

  it("moves visible columns earlier or later while clamping at the edges", () => {
    expect(moveVisibleScanColumn(["symbol", "score", "price"], "price", -1)).toEqual(["symbol", "price", "score"]);
    expect(moveVisibleScanColumn(["symbol", "score", "price"], "symbol", -1)).toEqual(["symbol", "score", "price"]);
    expect(moveVisibleScanColumn(["symbol", "score", "price"], "price", 1)).toEqual(["symbol", "score", "price"]);
  });
});
