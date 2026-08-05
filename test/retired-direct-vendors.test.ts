import { describe, expect, it } from "vitest";
import {
  directVendorRetirementMessage,
  isDirectVendorAccessAllowed,
  isRetiredDirectVendorUrl,
  RETIRED_DIRECT_VENDORS
} from "../src/lib/retired-direct-vendors";

describe("retired direct vendors policy", () => {
  it("bans FMP, QuiverQuant, and Unusual Whales with no override", () => {
    expect(RETIRED_DIRECT_VENDORS).toEqual(["fmp", "quiverquant", "unusual_whales"]);
    for (const vendor of RETIRED_DIRECT_VENDORS) {
      expect(isDirectVendorAccessAllowed(vendor)).toBe(false);
      expect(directVendorRetirementMessage(vendor)).toMatch(/Congress\.Trade/);
    }
  });

  it("flags known vendor host URLs", () => {
    expect(isRetiredDirectVendorUrl("https://financialmodelingprep.com/stable/profile")).toBe(true);
    expect(isRetiredDirectVendorUrl("https://api.quiverquant.com/beta/historical/congresstrading/AAPL")).toBe(true);
    expect(isRetiredDirectVendorUrl("https://api.unusualwhales.com/api/congress/recent-trades")).toBe(true);
    expect(isRetiredDirectVendorUrl("https://congress.trade/api/transactions")).toBe(false);
    expect(isRetiredDirectVendorUrl("https://query1.finance.yahoo.com/v8/finance/chart/AAPL")).toBe(false);
  });
});
