// Item 3 (2026-07-01 RAG workstream): confirm the paid-Voyage full-body ingest path actually runs
// end-to-end when its flags are enabled. WEB_SOURCE_SEC8K_FULL_BODY defaults OFF (config/cost
// decision — see docs/prod-config-voyage.md); this test proves the enablement path itself works,
// without flipping the default or making any live EDGAR/Voyage/Pinecone calls.

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-sec8k-full-body-${randomUUID()}.db`)}`;
});

const mocks = vi.hoisted(() => ({
  politeFetchText: vi.fn(),
  storeDocument: vi.fn().mockResolvedValue({ attempted: 1, indexed: 1 })
}));

vi.mock("../src/lib/web-sources/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/web-sources/http")>();
  return { ...actual, politeFetchText: mocks.politeFetchText };
});

vi.mock("../src/lib/vector-db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/vector-db")>();
  return { ...actual, storeDocument: mocks.storeDocument };
});

import { hasIngestedAccession } from "../src/lib/db";
import { eightKFullBodyEnabled, ingestEightKBody, ingestEightKBodies, type EightKEvent } from "../src/lib/web-sources/sec8k";

const SAMPLE_HTML = `<html><body><div>${"Material event details. ".repeat(30)}</div></body></html>`;

const EVENT: EightKEvent = {
  symbol: "AAPL",
  filedAt: "2026-06-30",
  accession: "0000320193-26-000099",
  filingUrl: "https://www.sec.gov/Archives/edgar/data/320193/000032019326000099/example-index.htm",
  items: ["Item 2.02 Results of Operations and Financial Condition"]
};

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.WEB_SOURCE_SEC8K_FULL_BODY;
  mocks.politeFetchText.mockResolvedValue(SAMPLE_HTML);
});

describe("eightKFullBodyEnabled (default-off corpus-enablement flag)", () => {
  it("is off by default", () => {
    delete process.env.WEB_SOURCE_SEC8K_FULL_BODY;
    expect(eightKFullBodyEnabled()).toBe(false);
  });
  it("turns on with WEB_SOURCE_SEC8K_FULL_BODY=on", () => {
    process.env.WEB_SOURCE_SEC8K_FULL_BODY = "on";
    expect(eightKFullBodyEnabled()).toBe(true);
  });
});

describe("ingestEightKBody (full-body ingest path when the flag is on)", () => {
  it("fetches the filing, chunks+stores it via storeDocument, and records the accession", async () => {
    const result = await ingestEightKBody(EVENT);

    expect(result.skipped).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.chunks).toBeGreaterThan(0);
    expect(mocks.politeFetchText).toHaveBeenCalledWith(
      EVENT.filingUrl,
      expect.objectContaining({ headers: expect.any(Object) })
    );
    expect(mocks.storeDocument).toHaveBeenCalledTimes(1);
    const [doc] = mocks.storeDocument.mock.calls[0]!;
    expect(doc).toMatchObject({ ticker: "AAPL", doc_type: "8-k", source: "sec-8k" });
    // Recorded in ingested_accessions so a second call for the same accession is skipped.
    expect(hasIngestedAccession(EVENT.accession, "8-K-body")).toBe(true);
  });

  it("skips a filing whose accession was already ingested (de-dup gate)", async () => {
    await ingestEightKBody(EVENT);
    mocks.storeDocument.mockClear();
    mocks.politeFetchText.mockClear();

    const second = await ingestEightKBody(EVENT);
    expect(second.skipped).toBe(true);
    expect(second.chunks).toBe(0);
    expect(mocks.politeFetchText).not.toHaveBeenCalled();
    expect(mocks.storeDocument).not.toHaveBeenCalled();
  });

  it("surfaces (does not swallow) a fetch failure", async () => {
    mocks.politeFetchText.mockRejectedValueOnce(new Error("EDGAR 503"));
    const event: EightKEvent = { ...EVENT, accession: "0000320193-26-000100" };
    const result = await ingestEightKBody(event);
    expect(result.skipped).toBe(false);
    expect(result.chunks).toBe(0);
    expect(result.error).toMatch(/fetch failed/);
    expect(mocks.storeDocument).not.toHaveBeenCalled();
  });
});

describe("ingestEightKBodies (batch path called from refreshEightK when the flag is on)", () => {
  it("ingests multiple events sequentially and aggregates the outcome", async () => {
    const events: EightKEvent[] = [
      { ...EVENT, accession: "0000320193-26-000201" },
      { ...EVENT, accession: "0000320193-26-000202" }
    ];
    const result = await ingestEightKBodies(events);
    expect(result.attempted).toBe(2);
    expect(result.ingested).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.errors).toEqual([]);
    expect(mocks.storeDocument).toHaveBeenCalledTimes(2);
  });
});
