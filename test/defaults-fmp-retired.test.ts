import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";

describe("DEFAULT_POLICY FMP toggles (retired product use)", () => {
  it("defaults all FMP policy modules to false", () => {
    expect(DEFAULT_POLICY.fmpRealTimeDataEnabled).toBe(false);
    expect(DEFAULT_POLICY.fmpMacroDataEnabled).toBe(false);
    expect(DEFAULT_POLICY.fmpEventsDataEnabled).toBe(false);
    expect(DEFAULT_POLICY.fmpFundamentalsDataEnabled).toBe(false);
  });
});
