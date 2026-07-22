import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function workflow(name: string): string {
  return readFileSync(join(repoRoot, ".github", "workflows", name), "utf8");
}

function topLevelBlock(source: string, key: string): string {
  return source.match(new RegExp(`^${key}:\\s*\\n((?:^[ \\t].*(?:\\n|$))*)`, "m"))?.[1] ?? "";
}

describe("CI queue safety", () => {
  it("preserves the active required verification run when a newer head arrives", () => {
    const concurrency = topLevelBlock(workflow("ci.yml"), "concurrency");

    expect(concurrency).toMatch(/^  cancel-in-progress:\s*false\s*$/m);
  });

  it("routes PR-adjacent security, pin, and smoke work to the live CI pool", () => {
    for (const name of ["security.yml", "shared-package-pin-check.yml", "e2e.yml"]) {
      const source = workflow(name);

      expect(source).toContain("runs-on: [self-hosted, socratic-ci]");
      expect(source).not.toContain("runs-on: [self-hosted, trading-live]");
    }
  });

  it("does not target the retired trading-live runner from any workflow", () => {
    const workflowsDir = join(repoRoot, ".github", "workflows");
    const workflowFiles = readdirSync(workflowsDir).filter(
      (name) => name.endsWith(".yml") || name.endsWith(".yaml")
    );

    for (const name of workflowFiles) {
      expect(workflow(name)).not.toContain("runs-on: [self-hosted, trading-live]");
    }
  });

  it("does not schedule Playwright smoke for every pull request", () => {
    const triggers = topLevelBlock(workflow("e2e.yml"), "on");

    expect(triggers).not.toMatch(/^  pull_request:/m);
    expect(triggers).not.toMatch(/^  merge_group:/m);
  });
});
