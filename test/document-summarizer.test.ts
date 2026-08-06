import { describe, it, expect, beforeEach } from "vitest";
import {
  insertDocumentAbstract,
  getDocumentAbstractsForTicker,
  getDocumentAbstractByAccession,
  DocumentAbstract
} from "../src/lib/db-document-abstracts";
import {
  generateAndStoreDocumentAbstract,
  tradeHighlightChunksFromText
} from "../src/lib/rag/document-summarizer";
import { getDb } from "../src/lib/db";

describe("Document Abstracts & Summarizer", () => {
  beforeEach(() => {
    const db = getDb();
    db.prepare("DELETE FROM document_abstracts").run();
  });

  it("tradeHighlightChunksFromText prefers guidance/revenue paragraphs and caps count", () => {
    const text = [
      "Boilerplate intro about the company history and founders with little market signal content here.",
      "",
      "We raised full-year guidance and now expect revenue growth of 12% with expanded operating margins.",
      "",
      "The cafeteria menu was updated for the summer picnic season and employee wellness programs.",
      "",
      "Management discussed EPS beats, backlog strength, and demand recovery in the core segment."
    ].join("\n");
    const chunks = tradeHighlightChunksFromText(text, { maxChunks: 2 });
    expect(chunks.length).toBe(2);
    expect(chunks[0].text.toLowerCase()).toMatch(/guidance|revenue|eps|backlog|demand/);
    expect(chunks.every((c) => c.id.startsWith("hl-"))).toBe(true);
  });

  it("tradeHighlightChunksFromText returns empty for blank input", () => {
    expect(tradeHighlightChunksFromText("   ")).toEqual([]);
  });

  it("inserts and retrieves document abstracts by ticker and accession", () => {
    const item: DocumentAbstract = {
      id: "abstract:10k-delta:AAPL:0000320193-24-000106",
      sourceType: "10k-delta",
      ticker: "AAPL",
      accessionOrEventId: "0000320193-24-000106",
      headline: "Apple Inc 10-K Delta Summary",
      summaryText: "Revenue grew 5% YoY driven by iPhone sales and Services expansion.",
      sourceChunkIds: ["chunk-1", "chunk-2"],
      createdAt: new Date().toISOString(),
      modelUsed: "test-model"
    };

    insertDocumentAbstract(item);

    const forTicker = getDocumentAbstractsForTicker("AAPL");
    expect(forTicker.length).toBe(1);
    expect(forTicker[0].headline).toBe("Apple Inc 10-K Delta Summary");
    expect(forTicker[0].sourceChunkIds).toEqual(["chunk-1", "chunk-2"]);

    const byAccession = getDocumentAbstractByAccession("0000320193-24-000106");
    expect(byAccession).toBeDefined();
    expect(byAccession?.ticker).toBe("AAPL");
  });

  it("generates and stores abstracts through the summarizer engine and skips duplicates", async () => {
    const result1 = await generateAndStoreDocumentAbstract({
      ticker: "MSFT",
      accessionOrEventId: "0000789019-24-000020",
      sourceType: "earnings-summary",
      headline: "MSFT Q4 Earnings Call Summary",
      chunks: [
        { id: "c1", text: "Azure cloud growth accelerated to 31% YoY." },
        { id: "c2", text: "Capital expenditure increased for AI infrastructure." }
      ]
    });

    expect(result1.skipped).toBe(false);
    expect(result1.abstractId).toBe("abstract:earnings-summary:MSFT:0000789019-24-000020");

    const fetched = getDocumentAbstractByAccession("0000789019-24-000020");
    expect(fetched).toBeDefined();
    expect(fetched?.summaryText).toContain("Azure cloud growth accelerated");

    // Second call for same accession & sourceType should skip
    const result2 = await generateAndStoreDocumentAbstract({
      ticker: "MSFT",
      accessionOrEventId: "0000789019-24-000020",
      sourceType: "earnings-summary",
      headline: "MSFT Q4 Earnings Call Summary",
      chunks: [{ id: "c1", text: "Azure cloud growth accelerated." }]
    });

    expect(result2.skipped).toBe(true);
  });
});
