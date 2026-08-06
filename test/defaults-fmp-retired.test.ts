import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { mergePolicy } from "../src/lib/db-profiles";
import { resolveApiKeyWithSource } from "../src/lib/db-api-keys";

describe("DEFAULT_POLICY FMP toggles (retired product use)", () => {
  it("defaults all FMP policy modules to false", () => {
    expect(DEFAULT_POLICY.fmpRealTimeDataEnabled).toBe(false);
    expect(DEFAULT_POLICY.fmpMacroDataEnabled).toBe(false);
    expect(DEFAULT_POLICY.fmpEventsDataEnabled).toBe(false);
    expect(DEFAULT_POLICY.fmpFundamentalsDataEnabled).toBe(false);
  });

  it("coerce-merge forces FMP toggles off even when stored policy had them on", () => {
    const merged = mergePolicy({
      fmpRealTimeDataEnabled: true,
      fmpMacroDataEnabled: true,
      fmpEventsDataEnabled: true,
      fmpFundamentalsDataEnabled: true
    });
    expect(merged.fmpRealTimeDataEnabled).toBe(false);
    expect(merged.fmpMacroDataEnabled).toBe(false);
    expect(merged.fmpEventsDataEnabled).toBe(false);
    expect(merged.fmpFundamentalsDataEnabled).toBe(false);
  });

  it("never resolves an FMP API key for product use", () => {
    process.env.FMP_API_KEY = "should-not-resolve";
    try {
      expect(resolveApiKeyWithSource("fmp", "local").key).toBeUndefined();
      expect(resolveApiKeyWithSource("fmp", "local").source).toBe("none");
    } finally {
      delete process.env.FMP_API_KEY;
    }
  });
});
