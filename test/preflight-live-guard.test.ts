import { afterEach, describe, expect, it } from "vitest";
import {
  assertLivePreflight,
  liveTradingEnabledByEnv,
  LivePreflightError,
  type LivePreflightInput
} from "../src/lib/preflight-live-guard";

// Pure guard — no DB, no I/O. These tests assert the default-SAFE contract: a no-op in Test/paper
// mode, and a hard block on the real-capital (broker/live) path unless live trading is explicitly
// enabled AND the run is genuinely out of paper mode. NEVER places a trade.

const originalAllowLive = process.env.ALLOW_LIVE_TRADING;

afterEach(() => {
  if (originalAllowLive === undefined) delete process.env.ALLOW_LIVE_TRADING;
  else process.env.ALLOW_LIVE_TRADING = originalAllowLive;
});

const testLocal: LivePreflightInput = { mode: "test/local", usesLocalSimulation: true, paperMode: true };
const brokerPaper: LivePreflightInput = { mode: "broker/paper", usesLocalSimulation: false, paperMode: false };
const brokerLive: LivePreflightInput = { mode: "broker/live", usesLocalSimulation: false, paperMode: false };

describe("assertLivePreflight — default-safe no-op cases", () => {
  it("is a no-op for the local simulator (test/local, paperMode)", () => {
    delete process.env.ALLOW_LIVE_TRADING;
    expect(() => assertLivePreflight(testLocal)).not.toThrow();
  });

  it("is a no-op for a broker paper sandbox (no real capital)", () => {
    delete process.env.ALLOW_LIVE_TRADING;
    expect(() => assertLivePreflight(brokerPaper)).not.toThrow();
  });

  it("is a no-op when usesLocalSimulation is true even if mode were misreported", () => {
    delete process.env.ALLOW_LIVE_TRADING;
    expect(() => assertLivePreflight({ mode: "broker/live", usesLocalSimulation: true, paperMode: true })).not.toThrow();
  });
});

describe("assertLivePreflight — broker/live path blocks by default", () => {
  it("BLOCKS a live order when live trading is not explicitly enabled (default off)", () => {
    delete process.env.ALLOW_LIVE_TRADING;
    expect(() => assertLivePreflight({ ...brokerLive, symbol: "AAPL", side: "buy" })).toThrow(LivePreflightError);
    expect(() => assertLivePreflight(brokerLive)).toThrow(/live trading is not/i);
  });

  it("BLOCKS a live order when paperMode is not explicitly false (inconsistent state)", () => {
    process.env.ALLOW_LIVE_TRADING = "true"; // even with the env opt-in, a bad paperMode is blocked
    // paperMode true on a live-mode state is a contradiction → blocked
    expect(() => assertLivePreflight({ mode: "broker/live", usesLocalSimulation: false, paperMode: true })).toThrow(
      /paperMode is not false/i
    );
  });

  it("ALLOWS a live order only when paperMode===false AND live trading is explicitly enabled (env)", () => {
    process.env.ALLOW_LIVE_TRADING = "true";
    expect(() => assertLivePreflight(brokerLive)).not.toThrow();
  });

  it("ALLOWS a live order when the per-call allowLive flag is set (no env needed)", () => {
    delete process.env.ALLOW_LIVE_TRADING;
    expect(() => assertLivePreflight({ ...brokerLive, allowLive: true })).not.toThrow();
  });

  it("per-call allowLive:false overrides an enabling env flag (still blocks)", () => {
    process.env.ALLOW_LIVE_TRADING = "true";
    expect(() => assertLivePreflight({ ...brokerLive, allowLive: false })).toThrow(LivePreflightError);
  });
});

describe("liveTradingEnabledByEnv", () => {
  it("is false unless ALLOW_LIVE_TRADING is exactly 'true'", () => {
    delete process.env.ALLOW_LIVE_TRADING;
    expect(liveTradingEnabledByEnv()).toBe(false);
    process.env.ALLOW_LIVE_TRADING = "1";
    expect(liveTradingEnabledByEnv()).toBe(false);
    process.env.ALLOW_LIVE_TRADING = "TRUE";
    expect(liveTradingEnabledByEnv()).toBe(false);
    process.env.ALLOW_LIVE_TRADING = "true";
    expect(liveTradingEnabledByEnv()).toBe(true);
  });
});
