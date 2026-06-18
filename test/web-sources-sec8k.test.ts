import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildEightKContext, parseCurrent8KFeed, parseCikTickerMap, parseEightKItemsFromHtml, getEightKSignals, mergeEightK, refreshEightK } from "../src/lib/web-sources/sec8k";
import { getSymbolWebSignals } from "../src/lib/web-sources";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-sec8k-${randomUUID()}.db`)}`;
});
beforeEach(async () => {
  const { deleteInternalSetting } = await import("../src/lib/db");
  for (const k of ["webSource:sec8k:dataset", "webSource:sec8k:lastAttempt", "webSource:sec:cikMap"]) deleteInternalSetting(k);
  delete process.env.WEB_SOURCE_SEC8K;
});
afterEach(() => vi.unstubAllGlobals());

describe("8-K parsers", () => {
  it("parses CIKs + accessions from the current-8-K feed (deduped)", () => {
    const atom = `<feed>
      <entry><title>8-K - APPLE INC (0000320193) (Filer)</title><link href="https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/0000320193-26-000001-index.htm"/><updated>2026-06-17T10:00:00-04:00</updated></entry>
      <entry><title>8-K - APPLE INC (0000320193) (Filer)</title><link href="https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/0000320193-26-000001-index.htm"/><updated>2026-06-17T10:00:00-04:00</updated></entry>
    </feed>`;
    const rows = parseCurrent8KFeed(atom);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cik: "320193", accession: "0000320193-26-000001", filedAt: "2026-06-17", filingUrl: "https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/0000320193-26-000001-index.htm" });
  });
  it("parses the CIK->ticker map", () => {
    const map = parseCikTickerMap({ "0": { cik_str: 320193, ticker: "AAPL" }, "1": { cik_str: 1045810, ticker: "NVDA" } });
    expect(map["320193"]).toBe("AAPL");
    expect(map["1045810"]).toBe("NVDA");
  });
  it("merges + prunes by accession and window", () => {
    const now = Date.parse("2026-06-17T00:00:00Z");
    const merged = mergeEightK(
      [{ symbol: "AAPL", filedAt: "2026-06-16", accession: "a1" }],
      [{ symbol: "AAPL", filedAt: "2026-06-17", accession: "a2" }, { symbol: "OLD", filedAt: "2026-01-01", accession: "old" }],
      now, 4
    );
    expect(merged.map((e) => e.accession).sort()).toEqual(["a1", "a2"]); // old pruned
  });
  it("parses SEC filing item labels and builds useful RAG context", () => {
    const html = `<div class="formGrouping"><div class="infoHead">Items</div><div class="info">Item 2.02 Results of Operations and Financial Condition; Item 9.01 Financial Statements and Exhibits</div></div>`;
    expect(parseEightKItemsFromHtml(html)).toEqual([
      "Item 2.02 Results of Operations and Financial Condition",
      "Item 9.01 Financial Statements and Exhibits"
    ]);
    const context = buildEightKContext({
      symbol: "AAPL",
      filedAt: "2026-06-17",
      accession: "0000320193-26-000001",
      filingUrl: "https://www.sec.gov/example-index.htm",
      items: ["Item 2.02 Results of Operations and Financial Condition"]
    });
    expect(context).toContain("Reported item(s): Item 2.02 Results of Operations and Financial Condition.");
    expect(context).toContain("SEC filing page: https://www.sec.gov/example-index.htm.");
  });
});

describe("getEightKSignals + refresh", () => {
  it("surfaces a catalyst bulletin for symbols with a recent 8-K", async () => {
    const { setInternalSetting } = await import("../src/lib/db");
    const today = new Date().toISOString().slice(0, 10);
    setInternalSetting("webSource:sec8k:dataset", { events: [{ symbol: "AAPL", filedAt: today, accession: "a1", items: ["Item 5.02 Departure of Directors or Certain Officers"] }], fetchedAt: new Date().toISOString(), recordCount: 1 });
    const sig = getEightKSignals(["AAPL", "MSFT"]);
    expect(sig.AAPL.bulletin).toContain("filed an 8-K");
    expect(sig.AAPL.bulletin).toContain("Item 5.02");
    expect(sig.MSFT).toBeUndefined();
    expect(getSymbolWebSignals(["AAPL"]).AAPL?.bulletins.some((b) => b.includes("8-K"))).toBe(true);
  });

  it("scrapes feed + CIK map and persists", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      const u = String(url);
      if (u.includes("company_tickers.json")) return new Response(JSON.stringify({ "0": { cik_str: 320193, ticker: "AAPL" } }), { status: 200 });
      if (u.includes("action=getcurrent")) return new Response(`<feed><entry><title>8-K - APPLE INC (0000320193) (Filer)</title><link href="https://www.sec.gov/Archives/edgar/data/320193/000032019326000002/0000320193-26-000002-index.htm"/><updated>${new Date().toISOString()}</updated></entry></feed>`, { status: 200 });
      if (u.includes("0000320193-26-000002-index.htm")) return new Response(`<div class="formGrouping"><div class="infoHead">Items</div><div class="info">Item 2.02 Results of Operations and Financial Condition</div></div>`, { status: 200 });
      return new Response("nope", { status: 404 });
    });
    const result = await refreshEightK(Date.now(), true);
    expect(result.ok).toBe(true);
    expect(result.recordCount).toBe(1);
    expect(getEightKSignals(["AAPL"]).AAPL.count).toBe(1);
    expect(getEightKSignals(["AAPL"]).AAPL.bulletin).toContain("Item 2.02");
  });
});
