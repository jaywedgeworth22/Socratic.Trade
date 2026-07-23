import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiKeyFingerprint: vi.fn(async () => "fmp-fingerprint"),
  fetchWithRetry: vi.fn(),
  reserveProviderDispatch: vi.fn(() => ({
    admitted: true as const,
    attemptId: "attempt-1",
    authorityId: "local"
  })),
  markProviderDispatchStarted: vi.fn(),
  settleProviderDispatch: vi.fn(),
  cancelUndispatchedProviderReservation: vi.fn(),
  resolveProviderQuota: vi.fn(() => [{ maxRequests: 290, windowMs: 60_000 }])
}));

vi.mock("../src/lib/data-providers", () => ({
  apiKeyFingerprint: mocks.apiKeyFingerprint,
  fetchWithRetry: mocks.fetchWithRetry
}));
vi.mock("../src/lib/db-provider-dispatch", () => ({
  reserveProviderDispatch: mocks.reserveProviderDispatch,
  markProviderDispatchStarted: mocks.markProviderDispatchStarted,
  settleProviderDispatch: mocks.settleProviderDispatch,
  cancelUndispatchedProviderReservation: mocks.cancelUndispatchedProviderReservation
}));
vi.mock("../src/lib/provider-rate-limit", () => ({
  resolveProviderQuota: mocks.resolveProviderQuota
}));

import { requestFmp } from "../src/lib/fmp-common";

describe("shared FMP capability requests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FMP_API_KEY = "secret-fmp-key";
  });

  it("uses header auth and records a durable per-endpoint dispatch", async () => {
    mocks.fetchWithRetry.mockImplementation(async (_url, _init, options) => {
      options.durableAttempt.onDispatch();
      const response = new Response(JSON.stringify([{ symbol: "AAPL" }]), { status: 200 });
      options.durableAttempt.onResponse(response);
      return response;
    });

    await expect(requestFmp("/profile", { symbol: "AAPL" })).resolves.toEqual([{ symbol: "AAPL" }]);

    const [url, init, retry] = mocks.fetchWithRetry.mock.calls[0];
    expect(url).toBe("https://financialmodelingprep.com/stable/profile?symbol=AAPL");
    expect(url).not.toContain("secret-fmp-key");
    expect(new Headers(init.headers).get("apikey")).toBe("secret-fmp-key");
    expect(retry.retries).toBe(0);
    expect(mocks.reserveProviderDispatch).toHaveBeenCalledWith(expect.objectContaining({
      provider: "fmp",
      operation: "capability-profile",
      credentialRef: "fmp-fingerprint",
      windows: [{ maxUnits: 290, windowMs: 60_000 }]
    }));
    expect(mocks.markProviderDispatchStarted).toHaveBeenCalledWith("attempt-1");
    expect(mocks.settleProviderDispatch).toHaveBeenCalledWith("attempt-1", "succeeded", {
      outcomeCode: "validated-json"
    });
  });

  it("returns null for an entitlement response while recording the failed outcome", async () => {
    mocks.fetchWithRetry.mockImplementation(async (_url, _init, options) => {
      options.durableAttempt.onDispatch();
      const response = new Response("payment required", { status: 402 });
      options.durableAttempt.onResponse(response);
      return response;
    });

    await expect(requestFmp("/etf/holdings", { symbol: "SPY" })).resolves.toBeNull();
    expect(mocks.settleProviderDispatch).toHaveBeenCalledWith("attempt-1", "failed", {
      outcomeCode: "http-402"
    });
  });
});
