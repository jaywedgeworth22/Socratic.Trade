import { describe, expect, it } from "vitest";
import { matchToChunk } from "../src/lib/vector-db";

// I4: citations must carry REAL provenance (the Pinecone vector id, its score, and the chunk's own
// acceptance date) — never a fabricated `<SYMBOL>#i` id or the query's as_of.
describe("matchToChunk — real citation provenance (I4)", () => {
  it("uses the real vector id, score, source, acceptance date, and url", () => {
    const c = matchToChunk({
      id: "8-K:AAPL:0000320193-24-000123:1718000000",
      score: 0.87,
      metadata: {
        text: "Apple announced a new buyback.",
        source: "sec-edgar-8k",
        acceptance_datetime: "2024-06-10T16:30:00Z",
        url: "https://www.sec.gov/Archives/edgar/data/320193/000032019324000123.htm"
      }
    });
    expect(c.id).toBe("8-K:AAPL:0000320193-24-000123:1718000000");
    expect(c.id).not.toMatch(/#\d+$/); // NOT a fabricated <SYMBOL>#i id
    expect(c.score).toBe(0.87);
    expect(c.as_of).toBe("2024-06-10T16:30:00Z");
    expect(c.source).toBe("sec-edgar-8k");
    expect(c.url).toContain("sec.gov");
    expect(c.text).toBe("Apple announced a new buyback.");
  });

  it("falls back across as_of/timestamp and tolerates missing metadata", () => {
    expect(matchToChunk({ id: "x", score: 0.1, metadata: { text: "t", as_of: "2023-01-01" } }).as_of).toBe("2023-01-01");
    expect(matchToChunk({ id: "y", score: 0.1, metadata: { text: "t", timestamp: 1718000000 } }).as_of).toBe("1718000000");
    const bare = matchToChunk({ id: "z" });
    expect(bare.text).toBe("");
    expect(bare.score).toBe(0);
    expect(bare.as_of).toBeUndefined();
    expect(bare.url).toBeUndefined();
  });
});
