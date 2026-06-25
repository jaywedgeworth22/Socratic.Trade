import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { parseCompanyFacts, secXbrlEnrichmentEnabled } from "../src/lib/data-providers";

// Isolate the DB so this test does not collide with others.
beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-sec-xbrl-${randomUUID()}.db`)}`;
});

type Entry = { end: string; val: number; form?: string };

/**
 * Minimal companyfacts JSON. debtToEquity is computed from DEBT-specific concepts
 * (LongTermDebtNoncurrent + LongTermDebtCurrent), NOT total `Liabilities` — `Liabilities` is included
 * here only to prove it is ignored. Defaults: 2023 debt 480M+120M=600M / equity 300M → 2.00.
 */
function makeFixture(overrides?: {
  liabilityEntries?: Entry[];
  longTermDebtEntries?: Entry[] | null;
  currentDebtEntries?: Entry[] | null;
  equityEntries?: Entry[];
  dilutedEpsEntries?: Entry[];
  basicEpsEntries?: Entry[];
}) {
  const gaap: Record<string, unknown> = {
    Liabilities: {
      units: {
        USD: overrides?.liabilityEntries ?? [
          { end: "2022-12-31", val: 600_000_000, form: "10-K" }, // includes operating liabilities — must be IGNORED
          { end: "2023-12-31", val: 900_000_000, form: "10-K" }
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
  };
  // null override → omit the concept entirely (so "no debt concept" can be exercised).
  if (overrides?.longTermDebtEntries !== null) {
    gaap.LongTermDebtNoncurrent = {
      units: {
        USD: overrides?.longTermDebtEntries ?? [
          { end: "2022-12-31", val: 320_000_000, form: "10-K" },
          { end: "2023-12-31", val: 480_000_000, form: "10-K" }
        ]
      }
    };
  }
  if (overrides?.currentDebtEntries !== null) {
    gaap.LongTermDebtCurrent = {
      units: {
        USD: overrides?.currentDebtEntries ?? [
          { end: "2022-12-31", val: 80_000_000, form: "10-K" },
          { end: "2023-12-31", val: 120_000_000, form: "10-K" }
        ]
      }
    };
  }
  return { facts: { "us-gaap": gaap } };
}

describe("parseCompanyFacts — debtToEquity (debt-specific concepts)", () => {
  it("computes from DEBT concepts (LT noncurrent + current) ÷ equity at the latest period", () => {
    // 2023: (480M + 120M) / 300M = 2.00 — NOT 900M Liabilities/300M = 3.00.
    expect(parseCompanyFacts(makeFixture()).debtToEquity).toBe(2.0);
  });

  it("ignores total Liabilities (operating liabilities don't inflate leverage)", () => {
    const r = parseCompanyFacts(
      makeFixture({
        liabilityEntries: [{ end: "2023-12-31", val: 5_000_000_000, form: "10-K" }], // huge operating liabilities
        longTermDebtEntries: [{ end: "2023-12-31", val: 30_000_000, form: "10-K" }], // modest real debt
        currentDebtEntries: null,
        equityEntries: [{ end: "2023-12-31", val: 300_000_000, form: "10-K" }]
      })
    );
    expect(r.debtToEquity).toBe(0.1); // 30M/300M, not 5B/300M
  });

  it("omits debtToEquity when NO debt-specific concept exists (does not fall back to Liabilities)", () => {
    const r = parseCompanyFacts(makeFixture({ longTermDebtEntries: null, currentDebtEntries: null }));
    expect(r.debtToEquity).toBeUndefined();
    expect(r.eps).toBe(4.8); // EPS still resolves
  });

  it("aligns debt and equity on the SAME period (a newer non-10-K debt fact is not combined with older equity)", () => {
    const r = parseCompanyFacts(
      makeFixture({
        equityEntries: [{ end: "2023-12-31", val: 300_000_000, form: "10-K" }],
        longTermDebtEntries: [
          { end: "2023-12-31", val: 480_000_000, form: "10-K" },
          { end: "2024-03-31", val: 9_000_000_000 } // newer non-10-K — must NOT pair with 2023 equity
        ],
        currentDebtEntries: [{ end: "2023-12-31", val: 120_000_000, form: "10-K" }]
      })
    );
    expect(r.debtToEquity).toBe(2.0); // 600M/300M at the aligned 2023 period
  });

  it("rounds to 2 decimals and handles a single debt concept", () => {
    const r = parseCompanyFacts(
      makeFixture({
        longTermDebtEntries: [{ end: "2023-12-31", val: 100, form: "10-K" }],
        currentDebtEntries: null,
        equityEntries: [{ end: "2023-12-31", val: 30, form: "10-K" }]
      })
    );
    expect(r.debtToEquity).toBe(3.33); // 100/30
  });

  it("omits debtToEquity when equity is zero or negative", () => {
    expect(parseCompanyFacts(makeFixture({ equityEntries: [{ end: "2023-12-31", val: 0, form: "10-K" }] })).debtToEquity).toBeUndefined();
    expect(parseCompanyFacts(makeFixture({ equityEntries: [{ end: "2023-12-31", val: -100, form: "10-K" }] })).debtToEquity).toBeUndefined();
  });

  it("prefers 10-K debt/equity entries over non-10-K at the same scan", () => {
    const r = parseCompanyFacts(
      makeFixture({
        equityEntries: [
          { end: "2023-12-31", val: 300_000_000, form: "10-K" },
          { end: "2024-03-31", val: 999_999_999 } // non-10-K, later — latestEntry prefers the 10-K
        ],
        longTermDebtEntries: [{ end: "2023-12-31", val: 600_000_000, form: "10-K" }],
        currentDebtEntries: null
      })
    );
    expect(r.debtToEquity).toBe(2.0);
  });
});

describe("parseCompanyFacts — eps (latest period, diluted-preferred-within-period)", () => {
  it("prefers diluted EPS within the latest period", () => {
    expect(parseCompanyFacts(makeFixture()).eps).toBe(4.8);
  });

  it("uses the NEWER basic EPS when diluted is stale (only older diluted exists)", () => {
    // Reviewer scenario: diluted only has 2022; basic has a newer 2023 → must return basic 4.9, not stale 3.5.
    const r = parseCompanyFacts(
      makeFixture({
        dilutedEpsEntries: [{ end: "2022-12-31", val: 3.5, form: "10-K" }],
        basicEpsEntries: [
          { end: "2022-12-31", val: 3.6, form: "10-K" },
          { end: "2023-12-31", val: 4.9, form: "10-K" }
        ]
      })
    );
    expect(r.eps).toBe(4.9);
  });

  it("falls back to basic EPS when diluted is absent entirely", () => {
    expect(parseCompanyFacts(makeFixture({ dilutedEpsEntries: [] })).eps).toBe(4.9);
  });
});

describe("parseCompanyFacts — defensive", () => {
  it("returns {} on missing us-gaap / null / non-object / empty / malformed", () => {
    expect(parseCompanyFacts({ facts: {} })).toEqual({});
    expect(parseCompanyFacts(null)).toEqual({});
    expect(parseCompanyFacts("garbage")).toEqual({});
    expect(parseCompanyFacts(42)).toEqual({});
    expect(parseCompanyFacts([])).toEqual({});
    expect(parseCompanyFacts({})).toEqual({});
    expect(parseCompanyFacts({ facts: { dei: { units: {} } } })).toEqual({});
  });
});

describe("secXbrlEnrichmentEnabled", () => {
  const original = process.env.SEC_XBRL_ENRICHMENT_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.SEC_XBRL_ENRICHMENT_ENABLED;
    else process.env.SEC_XBRL_ENRICHMENT_ENABLED = original;
  });

  it("defaults to false and rejects off/empty", () => {
    delete process.env.SEC_XBRL_ENRICHMENT_ENABLED;
    expect(secXbrlEnrichmentEnabled()).toBe(false);
    process.env.SEC_XBRL_ENRICHMENT_ENABLED = "off";
    expect(secXbrlEnrichmentEnabled()).toBe(false);
    process.env.SEC_XBRL_ENRICHMENT_ENABLED = "";
    expect(secXbrlEnrichmentEnabled()).toBe(false);
  });

  it("accepts 1/true/on/yes, case-insensitively", () => {
    for (const v of ["1", "true", "on", "yes", "ON", "True"]) {
      process.env.SEC_XBRL_ENRICHMENT_ENABLED = v;
      expect(secXbrlEnrichmentEnabled()).toBe(true);
    }
  });
});
