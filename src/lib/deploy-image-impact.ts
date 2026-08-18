// Classify whether a Coolify image rebuild can change socratictrade.com.
//
// Tonight 2026-08-17 ~7:15-7:49pm CT, docs-only #2811 (sha 23412aff) still
// triggered stop-old-then-start.  The production image does not even contain
// most of those files (.dockerignore drops docs/** except docs/benchmarks).
// A no-op rebuild must not take origin down for the ~30 min Horizon build.
//
// Fail CLOSED for skip: unknown / mixed paths are treated as image-relevant.
// Do not enable Coolify rolling to hide this -- two Litestream writers wedge
// L2.  Consistent container name stays on.

export function parseChangedFiles(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/** Same rule as `.github/workflows/ci.yml` classify: `*.md` anywhere or `docs/**`. */
export function isDocsOnlyPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized.endsWith(".md")) return true;
  return normalized === "docs" || normalized.startsWith("docs/");
}

export function isDocsOnlyChange(paths: readonly string[]): boolean {
  if (paths.length === 0) return false;
  return paths.every((path) => isDocsOnlyPath(path));
}

/**
 * Paths that cannot change the Coolify runtime image.  `docs/benchmarks/**`
 * is image-relevant (Next imports those JSON files at build time).
 */
export function isImageNoopPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized.startsWith("docs/benchmarks/") || normalized === "docs/benchmarks") {
    return false;
  }
  if (normalized.endsWith(".md")) return true;
  if (normalized === "docs" || normalized.startsWith("docs/")) return true;
  if (normalized === "ios" || normalized.startsWith("ios/")) return true;
  if (normalized === "test" || normalized.startsWith("test/")) return true;
  if (normalized === ".github" || normalized.startsWith(".github/")) return true;
  if (normalized === ".cursor" || normalized.startsWith(".cursor/")) return true;
  if (normalized === ".claude" || normalized.startsWith(".claude/")) return true;
  if (normalized === "ci-pending" || normalized.startsWith("ci-pending/")) return true;
  if (normalized === "pdf_pages" || normalized.startsWith("pdf_pages/")) return true;
  if (normalized === "reference" || normalized.startsWith("reference/")) return true;
  if (normalized.endsWith(".pdf") || normalized.endsWith(".PDF")) return true;
  return false;
}

export function isImageNoopChange(paths: readonly string[]): boolean {
  if (paths.length === 0) return false;
  return paths.every((path) => isImageNoopPath(path));
}

export const ISSUE_2811_DOCS_ONLY_PATHS = [
  "PLAN.md",
  "STATUS.md",
  "docs/EFFORT-LOG.md",
  "docs/audits/2026-08-18-pinecone-store-vs-condense.md",
  "docs/phase-7-strategy.md",
  "docs/rollouts/2026-08-18-pinecone-store-vs-condense.md"
] as const;
