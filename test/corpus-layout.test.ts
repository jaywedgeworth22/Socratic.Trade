import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  corpusKindDir,
  corpusRoot,
  firstExistingPath,
  readFirstExistingSync,
  secArtifactReadPaths,
  secArtifactWritePath
} from "../src/lib/rag/corpus-layout";

describe("corpus-layout", () => {
  afterEach(() => {
    delete process.env.CORPUS_DIR;
    delete process.env.DATA_DIR;
  });

  it("defaults corpus root to DATA_DIR/corpus and honors CORPUS_DIR", () => {
    process.env.DATA_DIR = "/tmp/st-data";
    expect(corpusRoot()).toBe(join("/tmp/st-data", "corpus"));
    expect(corpusKindDir("sec")).toBe(join("/tmp/st-data", "corpus", "sec"));
    process.env.CORPUS_DIR = "/mnt/corpus-disk";
    expect(corpusRoot()).toBe("/mnt/corpus-disk");
    expect(corpusKindDir("roic")).toBe(join("/mnt/corpus-disk", "roic"));
  });

  it("reads legacy data/sec-artifacts when the corpus/sec file is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "corpus-layout-"));
    process.env.DATA_DIR = root;
    delete process.env.CORPUS_DIR;
    const cik = "0000320193";
    const accession = "0000320193-24-000106";
    const legacyDir = join(root, "sec-artifacts", cik, accession);
    mkdirSync(legacyDir, { recursive: true });
    const legacyFile = join(legacyDir, "1-chunks.json");
    writeFileSync(legacyFile, JSON.stringify([{ text: "legacy 1A parent" }]), "utf8");

    const writePath = secArtifactWritePath(cik, accession, 1, "chunks.json");
    expect(writePath).toBe(join(root, "corpus", "sec", cik, accession, "1-chunks.json"));
    expect(firstExistingPath([writePath])).toBeNull();

    const reads = secArtifactReadPaths(cik, accession, 1, "chunks.json");
    expect(reads[0]).toBe(writePath);
    expect(reads[1]).toBe(legacyFile);
    const raw = readFirstExistingSync(reads);
    expect(raw).toContain("legacy 1A parent");
  });
});
