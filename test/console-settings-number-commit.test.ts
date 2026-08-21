import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveSourceFeatureNumberCommit } from "../app/console/lib/number-commit";

/**
 * console-ia-forms-blotters (keystroke-PATCH slice, docs/reviews/2026-08-18-full-app-expert-review.md):
 * the Settings > Data sources number rows PATCHed the server on every keystroke — the sole
 * numeric field on the console that didn't follow the blur-commit pattern every sibling field
 * uses (llm-budget.tsx, tax-settings.tsx, learning-review.tsx, strategy/page.tsx scoring
 * weights). Worse, RawNumInput's own onChange feeds `emptyValue` (the row's default) into
 * onValueChange the instant the field goes blank, so clearing a field to retype it wrote the
 * row's DEFAULT value to the server as a real setting on the very next keystroke — a silent
 * wrong write of a live scan-shape / RAG / rate-limit knob, not just extra traffic.
 *
 * resolveSourceFeatureNumberCommit is the pure decision the blur handler now uses: it must
 * never turn blank/unparseable text into a fallback write.
 */
describe("Settings > Data sources number rows: blur-commit, no fallback on empty", () => {
  it("blank text commits nothing (does not fall back to the row's committed/default value)", () => {
    expect(resolveSourceFeatureNumberCommit("", 5)).toBeNull();
  });

  it("whitespace-only text commits nothing", () => {
    expect(resolveSourceFeatureNumberCommit("   ", 25)).toBeNull();
  });

  it("unparseable text commits nothing", () => {
    expect(resolveSourceFeatureNumberCommit("abc", 4)).toBeNull();
    expect(resolveSourceFeatureNumberCommit("-", 4)).toBeNull();
  });

  it("a value equal to what's already committed is a no-op (no redundant PATCH)", () => {
    expect(resolveSourceFeatureNumberCommit("16", 16)).toBeNull();
  });

  it("a real, changed, parseable value commits the parsed number", () => {
    expect(resolveSourceFeatureNumberCommit("42", 16)).toBe(42);
  });

  it("never resolves blank text to the field's default the way the old emptyValue fallback did", () => {
    // Regression pin for the literal defect: WEB_SOURCE_SEC8K_RAG_LIMIT's default is 16 — the
    // old RawNumInput wiring passed `emptyValue={Number(row.defaultValue) || 0}` straight into
    // saveOne() on every keystroke, so clearing the field wrote 16 (its default), not nothing.
    const committedValue = 5; // a different row's committed value, e.g. WEB_SOURCE_SEC8K_FULL_BODY_LIMIT
    const oldFallbackDefault = 16;
    const result = resolveSourceFeatureNumberCommit("", committedValue);
    expect(result).toBeNull();
    expect(result).not.toBe(oldFallbackDefault);
  });
});

describe("Settings > Data sources number rows: commit happens on blur, not on every keystroke", () => {
  const src = readFileSync(new URL("../app/console/settings/page.tsx", import.meta.url), "utf8");

  it("the number row's onValueChange only updates local draft text — it never calls saveOne", () => {
    const match = src.match(/onValueChange=\{([^}]*setNumberDrafts[^}]*)\}/);
    expect(match, "expected the number row's onValueChange prop to update numberDrafts").toBeTruthy();
    expect(match![1]).not.toContain("saveOne");
    expect(match![1]).not.toContain("patchSourceFeatures");
  });

  it("the number row wires onBlur to the commit path (the only place that can PATCH)", () => {
    expect(src).toMatch(/onBlur=\{\(\)\s*=>\s*void commitNumberRow\(row\)\}/);
  });

  it("commitNumberRow — the sole caller of saveOne for typed text — routes through the no-fallback decision function", () => {
    const fnMatch = src.match(/const commitNumberRow = async \(row: SourceFeatureRow\) => \{([\s\S]*?)\n  \};/);
    expect(fnMatch, "expected to find the commitNumberRow function body").toBeTruthy();
    expect(fnMatch![1]).toContain("resolveSourceFeatureNumberCommit");
    expect(fnMatch![1]).toContain("saveOne(row.id, next)");
  });
});
