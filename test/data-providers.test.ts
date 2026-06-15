import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getEnrichmentProvider, noopProvider, scoreHeadlines } from "../src/lib/data-providers";

describe("market enrichment provider", () => {
  const originalKey = process.env.FMP_API_KEY;

  beforeEach(() => {
    delete process.env.FMP_API_KEY;
  });

  afterEach(() => {
    if (originalKey) process.env.FMP_API_KEY = originalKey;
    else delete process.env.FMP_API_KEY;
  });

  it("falls back to a no-op provider when no API key is configured", async () => {
    const provider = getEnrichmentProvider();
    expect(provider.configured).toBe(false);
    expect(await provider.enrich(["AAPL", "MSFT"])).toEqual({});
  });

  it("noopProvider never throws and returns no enrichment", async () => {
    expect(noopProvider.configured).toBe(false);
    expect(await noopProvider.enrich(["AAPL"])).toEqual({});
  });
});

describe("scoreHeadlines", () => {
  it("returns neutral 50 with no headlines or no signal words", () => {
    expect(scoreHeadlines([])).toBe(50);
    expect(scoreHeadlines(["Company holds annual meeting"])).toBe(50);
  });

  it("scores positive headlines above 50 and negative below 50", () => {
    expect(scoreHeadlines(["Stock surges as company beats earnings and raises guidance"])).toBeGreaterThan(50);
    expect(scoreHeadlines(["Shares plunge on downgrade and profit warning"])).toBeLessThan(50);
  });
});
