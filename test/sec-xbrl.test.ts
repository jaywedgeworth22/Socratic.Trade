import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { parseCompanyFacts, secXbrlEnrichmentEnabled } from "../src/lib/data-providers";

// Isolate the DB so this test does not collide with others.
beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-sec-xbrl-${randomUUID()}.db`)}`;
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Minimal companyfacts JSON matching the SEC EDGAR schema. */
function makeFixture(overrides?: {
  liabilityEntries?: Array<{ end: string; val: number; form?: string }>;
  equityEntries?: Array<{ end: string; val: number; form?: string }>;
  dilutedEpsEntries?: Array<{ end: string; val: number; form?: string }>;
  basicEpsEntries?: Array<{ end: string; val: number; form?: string }>;
}) {
  return {
    facts: {
      "us-gaap": {
        Liabilities: {
          units: {
            USD: overrides?.liabilityEntries ?? [
              { end: "2022-12-31", val: 400_000_000, form: "10-K" },
              { end: "2023-12-31", val: 600_000_000, form: "10-K" }
            ]
          }
        },
        StockholdersEquity: {
          units: {
            USD: overrides?.equityEntries ?? [
              { end: "2022-12-31", val: 200_000_000, form: "10-K" },
              { end: "2023-12-31", val: 300_000_000, form: "10-K" }
            ]
          }
        },
        EarningsPerShareDiluted: {
          units: {
            "USD/shares": overrides?.dilutedEpsEntries ?? [
              { end: "2022-12-31", val: 3.5, form: "10-K" },
              { end: "2023-12-31", val: 4.8, form: "10-K" }
            ]
          }
        },
        EarningsPerShareBasic: {
          units: {
            "USD/shares": overrides?.basicEpsEntries ?? [
              { end: "2022-12-31", val: 3.6, form: "10-K" },
              { end: "2023-12-31", val: 4.9, form: "10-K" }
            ]
          }
        }
      }
    }
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("parseCompanyFacts", () => {
  it("returns correct debtToEquity from the latest 10-K entry", () => {
    const result = parseCompanyFacts(makeFixture());
    // Latest: Liabilities=600M, Equity=300M → 600/300 = 2.00
    expect(result.debtToEquity).toBe(2.00);
  });

  it("rounds debtToEquity to 2 decimal places", () => {
    const result = parseCompanyFacts(
      makeFixture({
        liabilityEntries: [{ end: "2023-12-31", val: 100, form: "10-K" }],
        equityEntries: [{ end: "2023-12-31", val: 30, form: "10-K" }]
      })
    );
    // 100 / 30 = 3.333... → rounded to 3.33
    expect(result.debtToEquity).toBe(3.33);
  });

  it("prefers diluted EPS over basic EPS", () => {
    const result = parseCompanyFacts(makeFixture());
    // diluted latest = 4.8, basic latest = 4.9 — diluted should win
    expect(result.eps).toBe(4.8);
  });

  it("falls back to basic EPS when diluted is absent", () => {
    const result = parseCompanyFacts(
      makeFixture({ dilutedEpsEntries: [] })
    );
    // basic latest = 4.9
    expect(result.eps).toBe(4.9);
  });

  it("takes the latest end date, not the first entry", () => {
    const result = parseCompanyFacts(
      makeFixture({
        liabilityEntries: [
          { end: "2023-12-31", val: 600_000_000, form: "10-K" },
          { end: "2022-12-31", val: 400_000_000, form: "10-K" }
        ],
        equityEntries: [
          { end: "2023-12-31", val: 300_000_000, form: "10-K" },
          { end: "2022-12-31", val: 200_000_000, form: "10-K" }
        ],
        dilutedEpsEntries: [
          { end: "2023-12-31", val: 4.8, form: "10-K" },
          { end: "2022-12-31", val: 3.5, form: "10-K" }
        ]
      })
    );
    expect(result.debtToEquity).toBe(2.00);
    expect(result.eps).toBe(4.8);
  });

  it("omits debtToEquity when equity is zero", () => {
    const result = parseCompanyFacts(
      makeFixture({
        equityEntries: [{ end: "2023-12-31", val: 0, form: "10-K" }]
      })
    );
    expect(result.debtToEquity).toBeUndefined();
  });

  it("omits debtToEquity when equity is negative", () => {
    const result = parseCompanyFacts(
      makeFixture({
        equityEntries: [{ end: "2023-12-31", val: -100_000_000, form: "10-K" }]
      })
    );
    expect(result.debtToEquity).toBeUndefined();
  });

  it("returns {} on completely missing us-gaap facts", () => {
    const result = parseCompanyFacts({ facts: {} });
    expect(result).toEqual({});
  });

  it("returns {} on null input", () => {
    expect(parseCompanyFacts(null)).toEqual({});
  });

  it("returns {} on non-object input", () => {
    expect(parseCompanyFacts("garbage")).toEqual({});
    expect(parseCompanyFacts(42)).toEqual({});
    expect(parseCompanyFacts([])).toEqual({});
  });

  it("returns {} on empty object input", () => {
    expect(parseCompanyFacts({})).toEqual({});
  });

  it("returns {} on malformed facts shape (no us-gaap key)", () => {
    const result = parseCompanyFacts({ facts: { "dei": { units: {} } } });
    expect(result).toEqual({});
  });

  it("gracefully handles missing Liabilities concept", () => {
    const fixture = makeFixture();
    // Remove Liabilities entirely from the fixture
    const noLiab = JSON.parse(JSON.stringify(fixture)) as typeof fixture;
    delete (noLiab.facts["us-gaap"] as Record<string, unknown>).Liabilities;
    const result = parseCompanyFacts(noLiab);
    expect(result.debtToEquity).toBeUndefined();
    // EPS should still work
    expect(result.eps).toBe(4.8);
  });

  it("prefers 10-K entries over non-10-K entries for debtToEquity", () => {
    const result = parseCompanyFacts(
      makeFixture({
        liabilityEntries: [
          { end: "2024-03-31", val: 999_999_999 },          // non-10-K, later date
          { end: "2023-12-31", val: 600_000_000, form: "10-K" }
        ],
        equityEntries: [
          { end: "2024-03-31", val: 999_999_999 },          // non-10-K, later date
          { end: "2023-12-31", val: 300_000_000, form: "10-K" }
        ]
      })
    );
    // Should use the 10-K entries (600M/300M=2.00), not the non-10-K entries
    expect(result.debtToEquity).toBe(2.00);
  });

  it("falls back to non-10-K entries when no 10-K present", () => {
    const result = parseCompanyFacts(
      makeFixture({
        liabilityEntries: [
          { end: "2023-09-30", val: 500_000_000 },
          { end: "2024-03-31", val: 800_000_000 }
        ],
        equityEntries: [
          { end: "2023-09-30", val: 250_000_000 },
          { end: "2024-03-31", val: 400_000_000 }
        ]
      })
    );
    // Latest by date: 800M/400M = 2.00
    expect(result.debtToEquity).toBe(2.00);
  });
});

describe("secXbrlEnrichmentEnabled", () => {
  const original = process.env.SEC_XBRL_ENRICHMENT_ENABLED;

  afterEach(() => {
    if (original === undefined) delete process.env.SEC_XBRL_ENRICHMENT_ENABLED;
    else process.env.SEC_XBRL_ENRICHMENT_ENABLED = original;
  });

  it("defaults to false when env var is unset", () => {
    delete process.env.SEC_XBRL_ENRICHMENT_ENABLED;
    expect(secXbrlEnrichmentEnabled()).toBe(false);
  });

  it("returns false for 'off'", () => {
    process.env.SEC_XBRL_ENRICHMENT_ENABLED = "off";
    expect(secXbrlEnrichmentEnabled()).toBe(false);
  });

  it("returns false for ''", () => {
    process.env.SEC_XBRL_ENRICHMENT_ENABLED = "";
    expect(secXbrlEnrichmentEnabled()).toBe(false);
  });

  it("returns true for 'on'", () => {
    process.env.SEC_XBRL_ENRICHMENT_ENABLED = "on";
    expect(secXbrlEnrichmentEnabled()).toBe(true);
  });

  it("returns true for 'true'", () => {
    process.env.SEC_XBRL_ENRICHMENT_ENABLED = "true";
    expect(secXbrlEnrichmentEnabled()).toBe(true);
  });

  it("returns true for '1'", () => {
    process.env.SEC_XBRL_ENRICHMENT_ENABLED = "1";
    expect(secXbrlEnrichmentEnabled()).toBe(true);
  });

  it("returns true for 'yes'", () => {
    process.env.SEC_XBRL_ENRICHMENT_ENABLED = "yes";
    expect(secXbrlEnrichmentEnabled()).toBe(true);
  });

  it("is case-insensitive", () => {
    process.env.SEC_XBRL_ENRICHMENT_ENABLED = "ON";
    expect(secXbrlEnrichmentEnabled()).toBe(true);
    process.env.SEC_XBRL_ENRICHMENT_ENABLED = "True";
    expect(secXbrlEnrichmentEnabled()).toBe(true);
  });
});
