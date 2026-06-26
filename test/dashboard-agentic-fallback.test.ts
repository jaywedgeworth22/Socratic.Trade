/**
 * connectedAccountAgenticFallback — derives agentic-allowed for a STORED connected account when the
 * live broker enumeration is unavailable (so the readiness badge resolves instead of false-warning).
 */
import { describe, expect, it } from "vitest";
import { connectedAccountAgenticFallback } from "../src/lib/dashboard";

describe("connectedAccountAgenticFallback", () => {
  it("Robinhood: brokerage is allowed, IRA/Roth is not (mirrors the live gateway default)", () => {
    expect(connectedAccountAgenticFallback({ broker: "robinhood", capabilities: { accountType: "brokerage" } })).toBe(true);
    expect(connectedAccountAgenticFallback({ broker: "robinhood" })).toBe(true); // missing type → brokerage default
    expect(connectedAccountAgenticFallback({ broker: "robinhood", capabilities: { accountType: "roth_ira" } })).toBe(false);
    expect(connectedAccountAgenticFallback({ broker: "robinhood", capabilities: { accountType: "traditional_ira" } })).toBe(false);
  });

  it("Alpaca / Alpaca-MCP / Test: agentic-allowed for all their accounts", () => {
    expect(connectedAccountAgenticFallback({ broker: "alpaca", capabilities: { accountType: "roth_ira" } })).toBe(true);
    expect(connectedAccountAgenticFallback({ broker: "alpaca-mcp" })).toBe(true);
    expect(connectedAccountAgenticFallback({ broker: "test" })).toBe(true);
  });
});
