import { describe, expect, it } from "vitest";
import { chunkDocument, canonicalTicker } from "../src/lib/rag/chunk";
import { isWithinAsOf } from "../src/lib/vector-db";

describe("rag chunkDocument", () => {
  it("keeps tables atomic and carries section from headings", () => {
    const doc = {
      text: [
        "# Risk Factors",
        "",
        "Our business faces competition and supply-chain risk.",
        "",
        "| Metric | Value |",
        "| Rev | 100 |",
        "| Net | 20 |",
        "",
        "## Management Discussion",
        "",
        "Margins improved this quarter.",
      ].join("\n"),
      ticker: "aapl",
      doc_type: "10-K",
      source: "sec",
      acceptance_datetime: "2024-01-15",
    };
    const chunks = chunkDocument(doc);
    expect(chunks.length).toBeGreaterThanOrEqual(3);

    const table = chunks.find((c) => c.is_table);
    expect(table).toBeTruthy();
    expect(table!.text).toContain("| Rev | 100 |");
    expect(table!.text).toContain("| Net | 20 |");

    expect(chunks.some((c) => c.section === "Risk Factors")).toBe(true);
    expect(chunks.some((c) => /Management Discussion/i.test(c.section))).toBe(true);

    expect(chunks[0]!.context_header).toContain("AAPL");
    expect(chunks[0]!.ticker).toEqual(["AAPL"]);
    expect(chunks[0]!.acceptance_datetime).toContain("2024-01-15");
  });

  it("splits long prose into multiple windows under the token cap", () => {
    const longText = Array.from({ length: 1200 }, (_, i) => `word${i}`).join(" ");
    const chunks = chunkDocument({ text: longText }, { maxTokens: 100, overlapRatio: 0.1 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.text.split(/\s+/).filter(Boolean).length <= 100)).toBe(true);
  });

  it("requires doc.text", () => {
    expect(() => chunkDocument({ text: "" })).toThrow();
  });

  it("canonicalTicker uppercases and strips noise", () => {
    expect(canonicalTicker(" brk.b ")).toBe("BRK.B");
    expect(canonicalTicker("aapl123")).toBe("AAPL");
  });
});

describe("retrieveContext as_of guard (isWithinAsOf)", () => {
  it("drops chunks dated after the as-of date; keeps earlier and undated", () => {
    const asOf = "2024-06-01";
    expect(isWithinAsOf({ acceptance_datetime: "2024-01-15" }, asOf)).toBe(true);
    expect(isWithinAsOf({ acceptance_datetime: "2024-12-31" }, asOf)).toBe(false);
    expect(isWithinAsOf({ timestamp: "2025-01-01" }, asOf)).toBe(false);
    expect(isWithinAsOf({}, asOf)).toBe(true);
    expect(isWithinAsOf({ acceptance_datetime: "2024-12-31" }, undefined)).toBe(true);
  });
});
