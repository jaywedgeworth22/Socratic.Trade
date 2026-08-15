import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  parse13FInfoTable,
  parse13FPeriod,
  parseLatest13FFeed,
  pick13FXmls,
  previousQuarterEnd,
  getThirteenFSignals
} from "../src/lib/web-sources/thirteen-f";
import {
  extractArkCsvHref,
  parseArkCsvDate,
  parseArkHoldingsCsv,
  previousArkAsOf,
  getArkSignals
} from "../src/lib/web-sources/ark-holdings";
import { replaceThirteenFFiling, replaceArkFundDay, upsertCusipTicker } from "../src/lib/db";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-idea-${randomUUID()}.db`)}`;
});

const INFO_XML = `<?xml version="1.0"?>
<informationTable>
  <infoTable>
    <nameOfIssuer>APPLE INC</nameOfIssuer>
    <titleOfClass>COM</titleOfClass>
    <cusip>037833100</cusip>
    <value>2500000</value>
    <shrsOrPrnAmt><sshPrnamt>12000000</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt>
  </infoTable>
  <infoTable>
    <nameOfIssuer>TESLA INC</nameOfIssuer>
    <titleOfClass>COM</titleOfClass>
    <cusip>88160R101</cusip>
    <value>800000</value>
    <shrsOrPrnAmt><sshPrnamt>2000000</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt>
  </infoTable>
</informationTable>`;

const ARK_CSV = `date,fund,company,ticker,cusip,shares,market value ($),weight (%)
08/14/2026,ARKK,TESLA INC,TSLA,88160R101,"1,725,907","$586,739,343.72",9.16%
08/14/2026,ARKK,SHOPIFY INC - CLASS A,SHOP,82509L107,"1,829,471","$290,026,037.63",4.53%
`;

describe("13F parsers", () => {
  it("reads the latest 13F-HR accession from a company atom feed", () => {
    const atom = `<feed>
      <entry><link href="https://www.sec.gov/Archives/edgar/data/1067983/000095012326000111/0000950123-26-000111-index.htm"/></entry>
    </feed>`;
    expect(parseLatest13FFeed(atom)).toEqual({
      dir: "https://www.sec.gov/Archives/edgar/data/1067983/000095012326000111/",
      accession: "0000950123-26-000111"
    });
  });

  it("picks the information table XML", () => {
    const idx = { directory: { item: [{ name: "primary_doc.xml" }, { name: "form13fInfoTable.xml" }, { name: "R1.htm" }] } };
    expect(pick13FXmls(idx).infoTable).toBe("form13fInfoTable.xml");
    expect(pick13FXmls(idx).primary).toBe("primary_doc.xml");
  });

  it("parses period and info-table rows", () => {
    expect(parse13FPeriod("<reportCalendarOrQuarter>2026-03-31</reportCalendarOrQuarter>")).toBe("2026-03-31");
    const rows = parse13FInfoTable(INFO_XML);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ cusip: "037833100", shares: 12_000_000, valueThousands: 2_500_000 });
  });

  it("computes the prior quarter-end", () => {
    expect(previousQuarterEnd("2026-03-31")).toBe("2025-12-31");
    expect(previousQuarterEnd("2025-12-31")).toBe("2025-09-30");
  });

  it("emits an add bulletin when a tracked filer newly holds the name", () => {
    replaceThirteenFFiling([
      {
        id: "a1",
        filerCik: "0001067983",
        filerName: "Berkshire",
        periodEnd: "2026-03-31",
        accession: "acc-1",
        cusip: "037833100",
        ticker: "AAPL",
        issuerName: "APPLE INC",
        titleOfClass: "COM",
        shares: 12_000_000,
        valueUsd: 2_500_000_000,
        sshPrnType: "SH",
        fetchedAt: "2026-05-15T00:00:00Z"
      }
    ]);
    const signals = getThirteenFSignals(["AAPL", "MSFT"]);
    expect(signals.AAPL.bulletin).toMatch(/13F/);
    expect(signals.AAPL.bulletin).toMatch(/Berkshire/);
    expect(signals.MSFT).toBeUndefined();
  });
});

describe("ARK parsers", () => {
  it("parses official ARK CSV rows and dates", () => {
    expect(parseArkCsvDate("08/14/2026")).toBe("2026-08-14");
    const rows = parseArkHoldingsCsv(ARK_CSV);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ fund: "ARKK", ticker: "TSLA", weightPct: 9.16, shares: 1_725_907 });
  });

  it("extracts the official CSV href from holdings HTML", () => {
    const href = extractArkCsvHref(
      `<a href="https://assets.ark-funds.com/fund-documents/funds-etf-csv/ARK_INNOVATION_ETF_ARKK_HOLDINGS.csv" download>`
    );
    expect(href).toContain("ARK_INNOVATION_ETF_ARKK_HOLDINGS.csv");
  });

  it("picks the previous as-of date", () => {
    expect(previousArkAsOf("2026-08-14", ["2026-08-13", "2026-08-12", "2026-08-14"])).toBe("2026-08-13");
  });

  it("emits an ARK bulletin for a held ticker", () => {
    upsertCusipTicker("88160R101", "TSLA", "ark-csv", "2026-08-15T00:00:00Z");
    replaceArkFundDay([
      {
        id: "k1",
        asOf: "2026-08-14",
        fund: "ARKK",
        ticker: "TSLA",
        company: "TESLA INC",
        cusip: "88160R101",
        shares: 1_725_907,
        marketValueUsd: 586_739_343.72,
        weightPct: 9.16,
        fetchedAt: "2026-08-15T00:00:00Z"
      }
    ]);
    const signals = getArkSignals(["TSLA", "MSFT"]);
    expect(signals.TSLA.bulletin).toMatch(/ARK/);
    expect(signals.TSLA.bulletin).toMatch(/ARKK|held/);
    expect(signals.MSFT).toBeUndefined();
  });
});
