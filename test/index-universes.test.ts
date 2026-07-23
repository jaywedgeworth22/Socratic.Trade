import { describe, expect, it } from "vitest";
import {
  dynamicIndexUniversesForPolicy,
  normalizeIncludedIndices,
  policyUniverseSymbolCount,
  toggleIncludedIndex
} from "../src/lib/index-universes";

describe("index universes", () => {
  it("keeps S&P 100 and S&P 500 mutually exclusive", () => {
    expect(toggleIncludedIndex(["sp500"], "sp100", true)).toEqual(["sp100"]);
    expect(toggleIncludedIndex(["sp100"], "sp500", true)).toEqual(["sp500"]);
  });

  it("keeps Nasdaq 100 and Nasdaq Composite mutually exclusive", () => {
    expect(toggleIncludedIndex(["nasdaq100"], "nasdaqComposite", true)).toEqual(["nasdaqComposite"]);
    expect(toggleIncludedIndex(["nasdaqComposite"], "nasdaq100", true)).toEqual(["nasdaq100"]);
  });

  it("normalizes conflicting API-provided selections with the later selection winning", () => {
    expect(normalizeIncludedIndices(["sp500", "sp100", "dow30"])).toEqual(["sp100", "dow30"]);
    expect(normalizeIncludedIndices(["nasdaqComposite", "nasdaq100"])).toEqual(["nasdaq100"]);
  });

  it("reports approximate counts when selected universes are dynamic", () => {
    const summary = policyUniverseSymbolCount({
      includedIndices: ["russell2000"],
      additionalSymbols: ["SPCX"],
      blocklist: ["AAPL"]
    });

    expect(summary).toEqual({ count: 2000, approximate: true });
  });

  it("identifies selected dynamic universes", () => {
    expect(dynamicIndexUniversesForPolicy({ includedIndices: ["sp500", "nyseComposite", "dow30"] })).toEqual(["nyseComposite"]);
  });
});
