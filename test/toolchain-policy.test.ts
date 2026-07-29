import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

type PackageJson = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  overrides?: Record<string, unknown>;
};

type LockPackage = {
  name?: string;
  version?: string;
  devDependencies?: Record<string, string>;
};

type PackageLock = {
  packages?: Record<string, LockPackage>;
};

type DependabotIgnore = {
  "dependency-name"?: string;
  "update-types"?: string[];
};

type DependabotConfig = {
  updates?: Array<{
    "package-ecosystem"?: string;
    directory?: string;
    ignore?: DependabotIgnore[];
  }>;
};

type WorkflowStep = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
};

type WorkflowConfig = {
  jobs?: Record<string, { steps?: WorkflowStep[] }>;
};

const require = createRequire(import.meta.url);
const { load: loadYaml } = require("js-yaml") as {
  load: (source: string) => unknown;
};

const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as PackageJson;
const packageLock = JSON.parse(readFileSync("package-lock.json", "utf8")) as PackageLock;

const skippedSourceDirectories = new Set([
  ".git",
  ".next",
  ".agents",
  ".claude",
  ".design-sync",
  ".ds-sync",
  ".tools",
  ".vercel",
  "build",
  "coverage",
  "data",
  "docs",
  "ds-bundle",
  "node_modules",
  "out",
  "playwright-report",
  "public",
  "scratch",
  "test",
  "test-results",
]);

const forbiddenToolchainPatterns: ReadonlyArray<readonly [string, RegExp]> = [
  ["compiler alias", /\btypescript-v\d+\b|npm:typescript@/i],
  ["module-resolution monkeypatch", /\bModule\._resolve(?:Filename)?\b|\b_resolveFilename\b/],
  ["compiler source mutation", /node_modules[\\/]+typescript[\\/]+lib\b/i],
  ["runtime preload", /--require(?:=|\s)/],
  ["NODE_OPTIONS short preload", /\b(?:NODE_OPTIONS|node-options)\b[^\r\n]*(?:^|[\s=])-r(?:[\s=])/im],
  ["Next type-check bypass", /\bignoreBuildErrors\b/],
];

function parseYaml<T>(path: string): T {
  return loadYaml(readFileSync(path, "utf8")) as T;
}

function collectActiveToolchainSources(directory = "."): string[] {
  const paths: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skippedSourceDirectories.has(entry.name)) {
        paths.push(...collectActiveToolchainSources(join(directory, entry.name)));
      }
      continue;
    }

    if (!entry.isFile()) continue;
    const path = join(directory, entry.name);
    if (
      entry.name === ".npmrc" ||
      entry.name === "tsconfig.json" ||
      /\.(?:[cm]?[jt]sx?|ya?ml|sh)$/.test(entry.name)
    ) {
      paths.push(relative(".", path).split(sep).join("/"));
    }
  }

  return paths.sort();
}

function findForbiddenToolchainContent(label: string, source: string): string[] {
  return forbiddenToolchainPatterns
    .filter(([, pattern]) => pattern.test(source))
    .map(([description]) => `${label}: ${description}`);
}

function findIgnore(config: DependabotConfig, dependencyName: string): DependabotIgnore[] {
  const npmRoot = config.updates?.find(
    (update) => update["package-ecosystem"] === "npm" && update.directory === "/",
  );
  return (npmRoot?.ignore ?? []).filter(
    (entry) => entry["dependency-name"] === dependencyName,
  );
}

describe("supported TypeScript toolchain policy", () => {
  it("locks and installs exactly one supported TypeScript 6 compiler", () => {
    expect(packageJson.devDependencies?.typescript).toMatch(/^~6\.0\./);

    const compilerEntries = Object.entries(packageLock.packages ?? {}).filter(
      ([path, metadata]) =>
        /(?:^|\/)node_modules\/typescript$/.test(path) ||
        metadata.name === "typescript" ||
        path.startsWith("node_modules/@typescript/typescript-"),
    );

    expect(compilerEntries).toHaveLength(1);
    expect(compilerEntries[0]?.[0]).toBe("node_modules/typescript");
    expect(compilerEntries[0]?.[1].version).toMatch(/^6\.0\./);
    expect(packageLock.packages?.[""]?.devDependencies?.typescript).toBe(
      packageJson.devDependencies?.typescript,
    );

    const installedTypeScript = JSON.parse(
      readFileSync(require.resolve("typescript/package.json"), "utf8"),
    ) as { version?: string };
    expect(installedTypeScript.version).toBe(compilerEntries[0]?.[1].version);
  });

  it("has no compiler alias, preload, resolution hook, or node_modules mutation surface", () => {
    const manifestFindings = findForbiddenToolchainContent(
      "package.json dependencies and overrides",
      JSON.stringify({
        dependencies: packageJson.dependencies,
        devDependencies: packageJson.devDependencies,
        overrides: packageJson.overrides,
      }),
    );
    const scriptFindings = findForbiddenToolchainContent(
      "package.json scripts",
      Object.entries(packageJson.scripts ?? {})
        .map(([name, command]) => `${name}: ${command}`)
        .join("\n"),
    );
    const sourceFindings = collectActiveToolchainSources().flatMap((path) =>
      findForbiddenToolchainContent(path, readFileSync(path, "utf8")),
    );

    expect([...manifestFindings, ...scriptFindings, ...sourceFindings]).toEqual([]);
  });

  it("keeps Next production-build type validation enabled", () => {
    const nextConfig = readFileSync("next.config.mjs", "utf8");
    expect(findForbiddenToolchainContent("next.config.mjs", nextConfig)).toEqual([]);
  });

  it("pins the runtime, CI lanes, landing gate, and Node declarations to Node 24", () => {
    expect(readFileSync(".nvmrc", "utf8").trim()).toBe("24");
    expect(packageJson.devDependencies?.["@types/node"]).toMatch(/^\^24\./);

    const workflow = parseYaml<WorkflowConfig>(".github/workflows/ci.yml");
    const selfSteps = workflow.jobs?.["verify-self"]?.steps ?? [];
    const selectNode = selfSteps.find(
      (step) => step.name === "Select the supported Node 24 runtime",
    );
    expect(selectNode?.run).toContain("/opt/homebrew/opt/node@24/bin");
    expect(selectNode?.run).toContain("$GITHUB_PATH");
    expect(selectNode?.run).toContain("24.*");

    const selfGuard = selfSteps.find(
      (step) => step.name === "Fail fast if the runner box is not sane",
    );
    expect(selfGuard?.run).toContain("verify-self requires Node 24.x");
    expect(selfGuard?.run).toContain("24.*");

    const hostedSetup = workflow.jobs?.["verify-hosted"]?.steps?.find(
      (step) => step.uses?.startsWith("actions/setup-node"),
    );
    expect(String(hostedSetup?.with?.["node-version"])).toBe("24");

    const landScript = readFileSync("scripts/land.sh", "utf8");
    expect(landScript).toContain("Node 24.x is required");
    expect(landScript).toContain('case "$NODE_VERSION" in');
    expect(landScript).toContain("24.*)");
  });

  it("structurally blocks unsupported automated compiler and Node-type upgrades", () => {
    const dependabot = parseYaml<DependabotConfig>(".github/dependabot.yml");
    const typescriptIgnores = findIgnore(dependabot, "typescript");
    const nodeTypeIgnores = findIgnore(dependabot, "@types/node");

    expect(typescriptIgnores).toHaveLength(1);
    expect([...(typescriptIgnores[0]?.["update-types"] ?? [])].sort()).toEqual([
      "version-update:semver-major",
      "version-update:semver-minor",
    ]);
    expect(nodeTypeIgnores).toHaveLength(1);
    expect(nodeTypeIgnores[0]?.["update-types"]).toEqual([
      "version-update:semver-major",
    ]);
  });
});
