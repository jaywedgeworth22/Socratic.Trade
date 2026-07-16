import { describe, it, expect, beforeAll, vi } from "vitest";
import { getDb, applyVersionedMigrations } from "../src/lib/db";
import { parseAndSaveForm4, formatCompanyFactsEvidenceCard, ingestCompanyFacts } from "../src/lib/web-sources/sec-facts";
import { politeFetch } from "../src/lib/web-sources/http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-sec-facts-${randomUUID()}.db`)}`;
  const db = getDb();
  applyVersionedMigrations(db);
});

vi.mock("../src/lib/web-sources/http", () => ({
  politeFetch: vi.fn()
}));

describe("SEC Facts and Insider Transactions Ingestion (P4)", () => {
  it("should parse and save Form 4 XML insider transactions correctly", () => {
    const db = getDb();
    const xmlContent = `
      <reportingOwner>
        <reportingOwnerId>
          <rptOwnerName>Tim Cook</rptOwnerName>
        </reportingOwnerId>
        <reportingOwnerRelationship>
          <isOfficer>true</isOfficer>
          <officerTitle>Chief Executive Officer</officerTitle>
        </reportingOwnerRelationship>
      </reportingOwner>
      <periodOfReport>
        <value>2026-07-15</value>
      </periodOfReport>
      <nonDerivativeTransaction>
        <securityTitle><value>Common Stock</value></securityTitle>
        <transactionDate><value>2026-07-15</value></transactionDate>
        <transactionCoding><transactionCode>S</transactionCode></transactionCoding>
        <transactionAmounts>
          <transactionShares><value>10000</value></transactionShares>
          <transactionPricePerShare><value>190.50</value></transactionPricePerShare>
          <transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode>
        </transactionAmounts>
      </nonDerivativeTransaction>
      <nonDerivativeTransaction>
        <securityTitle><value>Common Stock</value></securityTitle>
        <transactionDate><value>2026-07-15</value></transactionDate>
        <transactionCoding><transactionCode>M</transactionCode></transactionCoding>
        <transactionAmounts>
          <transactionShares><value>5000</value></transactionShares>
          <transactionPricePerShare><value>120.00</value></transactionPricePerShare>
          <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>
        </transactionAmounts>
      </nonDerivativeTransaction>
    `;

    const count = parseAndSaveForm4(xmlContent, "0000320193", "0000320193-26-000010");
    expect(count).toBe(2);

    const rows = db.prepare("SELECT * FROM sec_insider_transactions WHERE cik = '0000320193' ORDER BY side DESC").all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      insider_name: "Tim Cook",
      relationship: "Chief Executive Officer",
      side: "sell",
      shares: 10000,
      price: 190.50
    });
    expect(rows[1]).toMatchObject({
      insider_name: "Tim Cook",
      side: "buy",
      shares: 5000,
      price: 120.00
    });
  });

  it("should ingest company facts from EDGAR API and record them in database", async () => {
    const db = getDb();
    const mockFacts = {
      cik: 320193,
      facts: {
        "us-gaap": {
          Assets: {
            units: {
              USD: [
                {
                  val: 350000000000,
                  accn: "0000320193-26-000010",
                  fy: 2025,
                  fp: "FY",
                  form: "10-K",
                  filed: "2025-10-31",
                  end: "2025-10-31",
                  frame: "CY2025"
                }
              ]
            }
          },
          NetIncomeLoss: {
            units: {
              USD: [
                {
                  val: 100000000000,
                  accn: "0000320193-26-000010",
                  fy: 2025,
                  fp: "FY",
                  form: "10-K",
                  filed: "2025-10-31",
                  end: "2025-10-31",
                  frame: "CY2025"
                }
              ]
            }
          }
        }
      }
    };

    vi.mocked(politeFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockFacts
    } as any);

    await ingestCompanyFacts("0000320193");

    const rows = db.prepare("SELECT * FROM sec_facts WHERE cik = '0000320193' ORDER BY concept ASC").all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      concept: "Assets",
      value: 350000000000,
      period: "CY2025"
    });
    expect(rows[1]).toMatchObject({
      concept: "NetIncomeLoss",
      value: 100000000000,
      period: "CY2025"
    });

    const card = formatCompanyFactsEvidenceCard("0000320193");
    expect(card).toContain("Assets: 350,000,000,000 USD");
    expect(card).toContain("NetIncomeLoss: 100,000,000,000 USD");
  });
});
