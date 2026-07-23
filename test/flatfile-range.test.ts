import { describe, expect, it } from "vitest";
import { businessDaysBetween, pivotDayAggsToSeries, type FlatFileBar } from "../src/lib/market-signals/massive-s3";

describe("businessDaysBetween", () => {
  it("returns inclusive weekdays, skipping Sat/Sun", () => {
    // 2026-06-25 is a Thursday; 2026-06-29 is the next Monday.
    expect(businessDaysBetween("2026-06-25", "2026-06-29")).toEqual([
      "2026-06-25", // Thu
      "2026-06-26", // Fri
      // 27 Sat, 28 Sun skipped
      "2026-06-29" // Mon
    ]);
  });

  it("handles a single day and an empty/reversed/invalid range", () => {
    expect(businessDaysBetween("2026-06-25", "2026-06-25")).toEqual(["2026-06-25"]); // Thursday
    expect(businessDaysBetween("2026-06-27", "2026-06-28")).toEqual([]); // Sat–Sun only
    expect(businessDaysBetween("2026-06-29", "2026-06-25")).toEqual([]); // reversed
    expect(businessDaysBetween("not-a-date", "2026-06-25")).toEqual([]);
  });
});

describe("pivotDayAggsToSeries", () => {
  const day = (date: string, rows: Array<[string, number, number?]>): { date: string; bars: FlatFileBar[] } => ({
    date,
    bars: rows.map(([ticker, close, volume]) => ({ ticker, close, volume }))
  });

  it("pivots per-day grouped bars into per-ticker ascending series with the file date as the bar time", () => {
    const series = pivotDayAggsToSeries([
      day("2026-06-23", [["AAPL", 200, 1000], ["MSFT", 400]]),
      day("2026-06-24", [["AAPL", 205, 1100]])
    ]);
    expect(series.get("AAPL")).toEqual([
      { time: "2026-06-23", open: undefined, high: undefined, low: undefined, close: 200, volume: 1000 },
      { time: "2026-06-24", open: undefined, high: undefined, low: undefined, close: 205, volume: 1100 }
    ]);
    expect(series.get("MSFT")).toHaveLength(1);
  });

  it("filters to the requested tickers and uppercases", () => {
    const series = pivotDayAggsToSeries(
      [day("2026-06-23", [["aapl", 200], ["NVDA", 1000], ["MSFT", 400]])],
      new Set(["AAPL", "NVDA"])
    );
    expect([...series.keys()].sort()).toEqual(["AAPL", "NVDA"]);
    expect(series.get("AAPL")?.[0].close).toBe(200);
  });
});
