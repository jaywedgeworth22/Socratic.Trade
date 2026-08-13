import { describe, expect, it } from "vitest";
import {
  mapYahooV7QuoteItem,
  yahooDividendYieldPercent,
  yahooFundamentalsFromRecord
} from "../src/lib/yahoo-finance";

describe("yahooDividendYieldPercent", () => {
  it("converts Yahoo's fraction into percentage points (matching quoteSummary)", () => {
    expect(yahooDividendYieldPercent(0.0032)).toBe(0.32);
    expect(yahooDividendYieldPercent(0)).toBe(0);
    expect(yahooDividendYieldPercent(-0.1)).toBeUndefined();
    expect(yahooDividendYieldPercent("nope")).toBeUndefined();
  });
});

describe("yahooFundamentalsFromRecord", () => {
  it("maps chart-meta / v7 fields without fabricating missing ones", () => {
    expect(
      yahooFundamentalsFromRecord({
        trailingPE: 26.4,
        epsTrailingTwelveMonths: 8.12,
        trailingAnnualDividendYield: 0.00321,
        beta: 1.01,
        fiftyTwoWeekHigh: 208.7,
        fiftyTwoWeekLow: 142.66
      })
    ).toEqual({
      peRatio: 26.4,
      eps: 8.12,
      dividendYield: 0.32,
      beta: 1.01,
      fiftyTwoWeekHigh: 208.7,
      fiftyTwoWeekLow: 142.66
    });

    expect(yahooFundamentalsFromRecord({ regularMarketPrice: 343.94 })).toEqual({});
    expect(yahooFundamentalsFromRecord({ trailingPE: 0, fiftyTwoWeekHigh: -1 })).toEqual({});
  });

  it("keeps a negative EPS so the sheet can show n/a instead of a fake P/E", () => {
    expect(yahooFundamentalsFromRecord({ trailingPE: -4, epsTrailingTwelveMonths: -1.2 })).toEqual({
      eps: -1.2
    });
  });
});

describe("mapYahooV7QuoteItem", () => {
  it("returns a full quote plus fundamentals for a valid v7 row", () => {
    const mapped = mapYahooV7QuoteItem({
      symbol: "GOOG",
      longName: "Alphabet Inc.",
      regularMarketPrice: 343.94,
      regularMarketPreviousClose: 342.2,
      regularMarketVolume: 14_897_228,
      regularMarketTime: 1_786_650_000,
      bid: 343.9,
      ask: 344.0,
      trailingPE: 26.4,
      epsTrailingTwelveMonths: 8.12,
      trailingAnnualDividendYield: 0.0032,
      beta: 1.01,
      fiftyTwoWeekHigh: 208.7,
      fiftyTwoWeekLow: 142.66
    });
    expect(mapped).toMatchObject({
      companyName: "Alphabet Inc.",
      price: 343.94,
      volume: 14_897_228,
      peRatio: 26.4,
      eps: 8.12,
      dividendYield: 0.32,
      beta: 1.01,
      fiftyTwoWeekHigh: 208.7,
      fiftyTwoWeekLow: 142.66,
      syntheticBid: false,
      syntheticAsk: false
    });
    expect(mapped?.syntheticSpread).toBeUndefined();
  });

  it("rejects a row with no usable price", () => {
    expect(mapYahooV7QuoteItem({ symbol: "GOOG", regularMarketPrice: 0 })).toBeUndefined();
  });
});
