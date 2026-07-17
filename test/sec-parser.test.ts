import { describe, it, expect } from "vitest";
import { parseFilingHtml } from "../src/lib/web-sources/sec-parser";
import { chunkDocument } from "../src/lib/rag/chunk";

describe("SEC Parser and Chunker (Phase 3)", () => {
  it("should strip script, style, and hidden elements", () => {
    const html = `
      <html>
        <head>
          <style>body { color: red; }</style>
          <script>console.log('hello');</script>
        </head>
        <body>
          <div>Visible text</div>
          <div style="display: none;">Hidden display none</div>
          <div style="visibility:hidden;">Hidden visibility hidden</div>
          <noscript>noscript text</noscript>
          <iframe>iframe text</iframe>
        </body>
      </html>
    `;
    const parsed = parseFilingHtml(html);
    expect(parsed.text).toContain("Visible text");
    expect(parsed.text).not.toContain("Hidden display none");
    expect(parsed.text).not.toContain("Hidden visibility hidden");
    expect(parsed.text).not.toContain("noscript text");
    expect(parsed.text).not.toContain("iframe text");
  });

  it("should clean inline-XBRL tags preserving their content", () => {
    const html = `
      <div>
        <ix:nonNumeric name="us-gaap:Revenue">10,000,000</ix:nonNumeric>
      </div>
    `;
    const parsed = parseFilingHtml(html);
    expect(parsed.text).toContain("10,000,000");
    expect(parsed.text).not.toContain("<ix:nonNumeric");
  });

  it("should normalize Item and Part headings", () => {
    const html = `
      <html>
        <body>
          <p>Some general information about the company.</p>
          <div>Item 1. Business</div>
          <p>This is business details.</p>
          <div>Item 1A. Risk Factors</div>
          <p>These are risk factors details.</p>
          <div>Part I. Item 2. Financial Statements</div>
          <p>Financial statements table is here.</p>
        </body>
      </html>
    `;
    const parsed = parseFilingHtml(html, { formType: "10-K" });
    expect(parsed.sections).toHaveLength(4); // GENERAL + 1 + 1A + 2

    expect(parsed.sections[1].itemCode).toBe("1");
    expect(parsed.sections[1].itemTitle).toBe("Business");
    expect(parsed.sections[1].text).toContain("This is business details.");

    expect(parsed.sections[2].itemCode).toBe("1A");
    expect(parsed.sections[2].itemTitle).toBe("Risk Factors");
    expect(parsed.sections[2].text).toContain("These are risk factors details.");

    expect(parsed.sections[3].itemCode).toBe("2");
    expect(parsed.sections[3].itemTitle).toBe("Financial Statements");
    expect(parsed.sections[3].text).toContain("Financial statements table is here.");
  });

  it("should preserve form-specific Item 1 titles (10-Q / unknown form keeps raw title)", () => {
    const html = `
      <html>
        <body>
          <div>Item 1. Financial Statements</div>
          <p>Condensed consolidated balance sheets.</p>
        </body>
      </html>
    `;

    // 10-Q: Item 1 is "Financial Statements" — the 10-K "Business" map must NOT apply.
    const tenQ = parseFilingHtml(html, { formType: "10-Q" });
    const tenQSection = tenQ.sections.find((s) => s.itemCode === "1");
    expect(tenQSection?.itemTitle).toBe("Financial Statements");

    // No form context: raw title preserved as well.
    const unknown = parseFilingHtml(html);
    const unknownSection = unknown.sections.find((s) => s.itemCode === "1");
    expect(unknownSection?.itemTitle).toBe("Financial Statements");

    // Proven 10-K: the canonical mapping applies.
    const tenK = parseFilingHtml(`<html><body><div>Item 1. Business</div><p>Details.</p></body></html>`, {
      formType: "10-K"
    });
    const tenKSection = tenK.sections.find((s) => s.itemCode === "1");
    expect(tenKSection?.itemTitle).toBe("Business");
  });

  it("should recognize standalone SEC section headings without an Item prefix", () => {
    const html = `
      <html>
        <body>
          <p>Cover page text.</p>
          <h2>Risk Factors</h2>
          <p>Standalone risk factor prose.</p>
          <h2>Management's Discussion and Analysis of Financial Condition and Results of Operations</h2>
          <p>MDA prose lives here.</p>
          <h2>Financial Statements</h2>
          <p>Statement prose lives here.</p>
          <p>For more detail, see Risk Factors above and our audited financial statements included elsewhere.</p>
        </body>
      </html>
    `;
    const parsed = parseFilingHtml(html);

    const risk = parsed.sections.find((s) => s.itemCode === "RISK-FACTORS");
    expect(risk?.itemTitle).toBe("Risk Factors");
    expect(risk?.text).toContain("Standalone risk factor prose.");

    const mda = parsed.sections.find((s) => s.itemCode === "MDA");
    expect(mda?.itemTitle).toBe("Management's Discussion and Analysis");
    expect(mda?.text).toContain("MDA prose lives here.");

    const fin = parsed.sections.find((s) => s.itemCode === "FINANCIAL-STATEMENTS");
    expect(fin?.itemTitle).toBe("Financial Statements");
    expect(fin?.text).toContain("Statement prose lives here.");

    // A prose paragraph merely REFERENCING a section name must not start a new
    // section (anchored full-text match) — it stays inside the last section.
    expect(fin?.text).toContain("see Risk Factors above");
    expect(parsed.sections.filter((s) => s.itemCode === "RISK-FACTORS")).toHaveLength(1);
  });

  it("should convert tables to pipe-delimited Markdown", () => {
    const html = `
      <table>
        <tr>
          <th>Header A</th>
          <th>Header B</th>
        </tr>
        <tr>
          <td>Value A1</td>
          <td>Value B1</td>
        </tr>
      </table>
    `;
    const parsed = parseFilingHtml(html);
    expect(parsed.text).toContain("| Header A | Header B |");
    expect(parsed.text).toContain("| --- | --- |");
    expect(parsed.text).toContain("| Value A1 | Value B1 |");
  });

  it("should split large tables exceeding the token limit", () => {
    // Generate a long table. Each row has ~100 characters.
    // 15 rows * 100 characters = 1500 characters / 3.5 = ~428 tokens
    let rowsHtml = "<tr><th>Col 1</th><th>Col 2</th></tr>";
    for (let i = 0; i < 15; i++) {
      rowsHtml += `<tr><td>Row ${i} Val 1 has a lot of text here to increase length</td><td>Row ${i} Val 2 has a lot of text too</td></tr>`;
    }
    const html = `<table>${rowsHtml}</table>`;
    const parsed = parseFilingHtml(html);

    // Should split into at least 2 tables
    const tableBlocks = parsed.text.split("\n\n").filter(b => b.startsWith("|"));
    expect(tableBlocks.length).toBeGreaterThan(1);
    
    // Each split table should contain the header row
    for (const table of tableBlocks) {
      expect(table).toContain("| Col 1 | Col 2 |");
      expect(table).toContain("| --- | --- |");
    }
  });

  it("should emit valid Markdown for td-only tables (synthesized empty header, no promoted data row)", () => {
    // td-only rows (no <th>): each emitted block must still be a valid GFM table.
    let rowsHtml = "";
    for (let i = 0; i < 15; i++) {
      rowsHtml += `<tr><td>Row ${i} Val 1 has a lot of text here to increase length</td><td>Row ${i} Val 2 has a lot of text too</td></tr>`;
    }
    const html = `<table>${rowsHtml}</table>`;
    const parsed = parseFilingHtml(html);

    const tableBlocks = parsed.text.split("\n\n").filter((b) => b.startsWith("|"));
    expect(tableBlocks.length).toBeGreaterThan(1); // still splits on the token cap

    for (const table of tableBlocks) {
      const lines = table.split("\n");
      // Valid GFM: a (neutral, empty-cell) header row precedes the delimiter row —
      // never a bare "| --- |" first line.
      expect(lines[0]).toBe("|  |  |");
      expect(lines[1]).toBe("| --- | --- |");
      expect(lines[0]).not.toContain("Row 0");
    }

    // No data row is promoted to a repeated header: every data row appears exactly once.
    for (let i = 0; i < 15; i++) {
      const occurrences = parsed.text.split(`Row ${i} Val 1`).length - 1;
      expect(occurrences).toBe(1);
    }
  });

  it("should chunk documents with section awareness and no cross-section overlap", () => {
    const html = `
      <html>
        <body>
          <div>Item 1. Business</div>
          <p>Business prose is very long and has multiple paragraphs. Business prose is very long and has multiple paragraphs.</p>
          <div>Item 1A. Risk Factors</div>
          <p>Risk prose details are here. Risk prose details are here.</p>
        </body>
      </html>
    `;
    const parsed = parseFilingHtml(html);
    const chunks = chunkDocument({
      text: parsed.text,
      sections: parsed.sections,
      doc_id: "AAPL:12345:10-K",
      ticker: "AAPL",
      published_at: "2026-01-01"
    }, {
      maxTokens: 50,
      overlapRatio: 0.1
    });

    expect(chunks.length).toBeGreaterThan(1);

    // Verify sections are correctly set in metadata
    const item1Chunks = chunks.filter(c => c.section === "1. Business");
    const item1AChunks = chunks.filter(c => c.section === "1A. Risk Factors");

    expect(item1Chunks.length).toBeGreaterThan(0);
    expect(item1AChunks.length).toBeGreaterThan(0);

    // Check that Item 1A chunks do not contain text from Item 1 (due to reset pending)
    for (const chunk of item1AChunks) {
      expect(chunk.text).not.toContain("Business prose");
    }
  });
});
