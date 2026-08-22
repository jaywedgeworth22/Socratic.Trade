import { describe, expect, it } from "vitest";
import {
  REVIEWER_FILINGS_PACK_CHARS,
  REVIEWER_PER_SYMBOL_CHARS,
  sliceRagDossierForSymbols
} from "../src/lib/rag/reviewer-filings-pack";

const pack = [
  "### RAG Dossier for AAPL\nItem 1A. Apple supply-chain risk and China.",
  "### RAG Dossier for MSFT\nItem 1A. Azure concentration and OpenAI.",
  "### RAG Dossier for NVDA\nItem 1A. Export controls and going-concern."
].join("\n\n---\n\n");

describe("sliceRagDossierForSymbols", () => {
  it("keeps only proposed symbols", () => {
    const sliced = sliceRagDossierForSymbols(pack, ["AAPL", "NVDA"]);
    expect(sliced).toContain("Apple supply-chain");
    expect(sliced).toContain("Export controls");
    expect(sliced).not.toContain("Azure concentration");
  });

  it("does not ship the full Green hose", () => {
    const huge = `### RAG Dossier for AAPL\n${"1A ".repeat(20_000)}`;
    const sliced = sliceRagDossierForSymbols(huge, ["AAPL"]);
    expect(sliced.length).toBeLessThanOrEqual(REVIEWER_PER_SYMBOL_CHARS);
    expect(sliced.length).toBeLessThan(REVIEWER_FILINGS_PACK_CHARS);
  });

  it("returns empty when no matching dossier", () => {
    expect(sliceRagDossierForSymbols(pack, ["TSLA"])).toBe("");
    expect(sliceRagDossierForSymbols("", ["AAPL"])).toBe("");
  });
});
