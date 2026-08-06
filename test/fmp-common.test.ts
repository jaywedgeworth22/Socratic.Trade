import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiKeyFingerprint: vi.fn(async () => "fmp-fingerprint"),
  fetchWithRetry: vi.fn()
}));

vi.mock("../src/lib/data-providers", () => ({
  apiKeyFingerprint: mocks.apiKeyFingerprint,
  fetchWithRetry: mocks.fetchWithRetry
}));

import { getFmpApiKey, requestFmp, scrubUrl } from "../src/lib/fmp-common";

describe("shared FMP capability requests (retired)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FMP_API_KEY = "secret-fmp-key";
  });

  it("requestFmp never opens a network call even with a key present", async () => {
    await expect(requestFmp("/profile", { symbol: "AAPL" })).resolves.toBeNull();
    expect(mocks.fetchWithRetry).not.toHaveBeenCalled();
  });

  it("getFmpApiKey refuses to treat the key as usable", () => {
    expect(() => getFmpApiKey()).toThrow(/retired/i);
  });

  it("scrubUrl still redacts apikey query params", () => {
    expect(scrubUrl("https://example.com/x?apikey=secret-fmp-key")).toContain("REDACTED");
    expect(scrubUrl("https://example.com/x?apikey=secret-fmp-key")).not.toContain("secret-fmp-key");
  });
});
