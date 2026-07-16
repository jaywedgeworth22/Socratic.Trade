import * as cheerio from "cheerio";

export interface ParsedBlock {
  type: "heading" | "paragraph" | "table";
  text: string;
  itemCode?: string;
  itemTitle?: string;
}

export interface ParsedFiling {
  text: string;
  sections: Array<{
    itemCode: string;
    itemTitle: string;
    text: string;
  }>;
}

const BLOCK_TAGS = new Set([
  "p",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "blockquote",
  "pre",
  "section",
  "article",
  "header",
  "footer",
  "main"
]);

/**
 * Estimates token counts using a calibrated character-level ratio.
 * For English prose, ~4.5 characters per token.
 */
export function estimateProseTokens(text: string): number {
  return Math.ceil(text.length / 4.5);
}

/**
 * Estimates token counts for Markdown tables, ~3.5 characters per token
 * (due to pipe formatting and whitespace padding).
 */
export function estimateTableTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

function hasBlockChildren($: any, node: any): boolean {
  if (!node.children) return false;
  for (const child of node.children) {
    if (child.type === "tag") {
      const childName = child.name.toLowerCase();
      if (BLOCK_TAGS.has(childName) || childName === "table") {
        return true;
      }
      if (hasBlockChildren($, child)) {
        return true;
      }
    }
  }
  return false;
}

function isHeadingBlock(text: string): boolean {
  const clean = text.trim();
  if (clean.length === 0 || clean.length > 150) return false;
  return /^\s*item\s+(\d+[a-z]?)\b/i.test(clean) || /^\s*part\s+(\d+|[ivx]+)\b/i.test(clean);
}

function standardizeTitle(code: string, rawTitle: string): string {
  let title = rawTitle;
  if (code === "1") title = "Business";
  else if (code === "1A") title = "Risk Factors";
  else if (code === "3") title = "Legal Proceedings";
  else if (code === "7") title = "Management's Discussion and Analysis";
  else if (code === "7A") title = "Quantitative and Qualitative Disclosures About Market Risk";
  else if (code === "8") title = "Financial Statements and Supplementary Data";
  else if (code === "9A") title = "Controls and Procedures";
  return title || rawTitle || `Item ${code}`;
}

function normalizeItemCode(text: string): { code: string; title: string } | null {
  const clean = text.trim();
  
  // Try matching "Item <number><letter>" first (most specific)
  const itemMatch = clean.match(/item\s+(\d+[a-z]?)\b/i);
  if (itemMatch) {
    const code = itemMatch[1].toUpperCase();
    const titleMatch = clean.match(/item\s+\d+[a-z]?[.\s-:\u2013\u2014]*(.*)/i);
    const rawTitle = titleMatch ? titleMatch[1].trim() : "";
    return { code, title: standardizeTitle(code, rawTitle) };
  }

  // Try matching "Part <number/roman>"
  const partMatch = clean.match(/part\s+(\d+|[ivx]+)\b/i);
  if (partMatch) {
    const code = partMatch[1].toUpperCase();
    const titleMatch = clean.match(/part\s+(?:\d+|[ivx]+)[.\s-:\u2013\u2014]*(.*)/i);
    const rawTitle = titleMatch ? titleMatch[1].trim() : "";
    return { code: `PART-${code}`, title: rawTitle || `Part ${code}` };
  }

  return null;
}

function splitTableRows(rows: string[][]): string[] {
  if (rows.length <= 1) {
    return [rows.map((row) => `| ${row.join(" | ")} |`).join("\n")];
  }
  const headerRow = rows[0];
  const colCount = headerRow.length;
  const divider = Array(colCount).fill("---");

  const tables: string[] = [];
  let currentGroup: string[][] = [headerRow, divider];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    // Check if adding this row exceeds the 400-token limit
    const proposedGroup = [...currentGroup, row];
    const markdown = proposedGroup.map((r) => `| ${r.join(" | ")} |`).join("\n");

    if (estimateTableTokens(markdown) > 400 && currentGroup.length > 2) {
      tables.push(currentGroup.map((r) => `| ${r.join(" | ")} |`).join("\n"));
      currentGroup = [headerRow, divider, row];
    } else {
      currentGroup.push(row);
    }
  }

  if (currentGroup.length > 2) {
    tables.push(currentGroup.map((r) => `| ${r.join(" | ")} |`).join("\n"));
  }
  return tables;
}

function collectBlocks($: any, node: any, blocks: ParsedBlock[]) {
  if (node.type !== "tag") return;

  const name = node.name.toLowerCase();
  if (name === "script" || name === "style" || name === "noscript" || name === "iframe" || name === "head") {
    return;
  }

  // Remove display: none or visibility: hidden elements
  const style = $(node).attr("style");
  if (style) {
    const isHidden = /display\s*:\s*none/i.test(style) || /visibility\s*:\s*hidden/i.test(style);
    if (isHidden) return;
  }

  // If table, convert and do not recurse into rows/cells
  if (name === "table") {
    const tableRows: string[][] = [];
    $(node).find("tr").each((_: any, tr: any) => {
      const row: string[] = [];
      $(tr).children("td, th").each((_: any, cell: any) => {
        // Replace <br> with space so concatenated text nodes stay separated
        $(cell).find("br").replaceWith(" ");
        row.push($(cell).text().replace(/\s+/g, " ").trim());
      });
      if (row.some((c) => c !== "")) {
        tableRows.push(row);
      }
    });

    if (tableRows.length > 0) {
      const splitTables = splitTableRows(tableRows);
      for (const tableMd of splitTables) {
        blocks.push({ type: "table", text: tableMd });
      }
    }
    return;
  }

  const text = $(node).text().trim();

  // If it's a heading tag, or matches heading pattern
  if (isHeadingBlock(text) && (BLOCK_TAGS.has(name) || name.match(/^h[1-6]$/))) {
    const norm = normalizeItemCode(text);
    if (norm) {
      blocks.push({
        type: "heading",
        text,
        itemCode: norm.code,
        itemTitle: norm.title
      });
      return;
    }
  }

  // If it's a block container with no block children, extract text and do not recurse
  if (BLOCK_TAGS.has(name) && !hasBlockChildren($, node)) {
    const cleanText = text.replace(/\s+/g, " ").trim();
    if (cleanText) {
      blocks.push({ type: "paragraph", text: cleanText });
    }
    return;
  }

  // Recurse into children
  if (node.children) {
    for (const child of node.children) {
      collectBlocks($, child, blocks);
    }
  }
}

/**
 * Parses raw SEC filing HTML using cheerio, removing styles/scripts,
 * extracting sections based on Item headings, and converting tables to Markdown.
 */
export function parseFilingHtml(html: string): ParsedFiling {
  const $ = cheerio.load(html);

  // Clean inline-XBRL tags: remove ix:hidden/ix:header entirely (their content is
  // non-rendered metadata or duplicate facts), unwrap the rest keeping their content.
  $("*").each((_, el) => {
    if (el.type === "tag" && el.name && el.name.toLowerCase().startsWith("ix:")) {
      const ixName = el.name.toLowerCase();
      if (ixName === "ix:hidden" || ixName === "ix:header") {
        $(el).remove();
      } else {
        $(el).replaceWith($(el).contents());
      }
    }
  });

  // Strip scripts/styles/noscript/iframe
  $("script, style, noscript, iframe, head").remove();

  const blocks: ParsedBlock[] = [];
  const body = $("body").get(0);
  if (body) {
    collectBlocks($, body, blocks);
  } else {
    // Fallback: collect blocks from root if body doesn't exist
    const root = $.root().get(0);
    if (root) collectBlocks($, root, blocks);
  }

  // Group blocks by section
  const sections: Array<{ itemCode: string; itemTitle: string; text: string }> = [];
  let currentItemCode = "GENERAL";
  let currentItemTitle = "General Section";
  let currentSectionText: string[] = [];

  for (const block of blocks) {
    if (block.type === "heading" && block.itemCode) {
      // Flush current section
      const joined = currentSectionText.join("\n\n").trim();
      if (joined) {
        sections.push({
          itemCode: currentItemCode,
          itemTitle: currentItemTitle,
          text: joined
        });
      }
      currentItemCode = block.itemCode;
      currentItemTitle = block.itemTitle || `Item ${block.itemCode}`;
      currentSectionText = [];
    } else {
      currentSectionText.push(block.text);
    }
  }

  // Flush last section
  const joined = currentSectionText.join("\n\n").trim();
  if (joined) {
    sections.push({
      itemCode: currentItemCode,
      itemTitle: currentItemTitle,
      text: joined
    });
  }

  // Construct full clean plain text
  const fullText = sections.map((s) => `## Item ${s.itemCode}. ${s.itemTitle}\n\n${s.text}`).join("\n\n");

  return {
    text: fullText,
    sections
  };
}
