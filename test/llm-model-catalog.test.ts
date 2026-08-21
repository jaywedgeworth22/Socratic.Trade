import os from "os";
import path from "path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL = `file:${path.join(os.tmpdir(), `llm-catalog-test-${Date.now()}.db`)}`;

const OWNER_ROWS: Array<[string, string, string]> = [
  ["gpt-5.6-sol", "openai/gpt-5.6-sol", "gpt-5.6-sol"],
  ["gpt-5.6-terra", "openai/gpt-5.6-terra", "gpt-5.6-terra"],
  ["gpt-5.6-luna", "openai/gpt-5.6-luna", "gpt-5.6-luna"],
  ["gpt-mini-latest", "~openai/gpt-mini-latest", "gpt-5.4-mini"],
  ["gpt-5.4-nano", "openai/gpt-5.4-nano", "gpt-5.4-nano"],
  ["gpt-4o", "openai/gpt-4o", "gpt-4o"],
  ["gpt-4o-mini", "openai/gpt-4o-mini", "gpt-4o-mini"],
  ["claude-sonnet-latest", "~anthropic/claude-sonnet-latest", "claude-sonnet-5"],
  ["claude-haiku-latest", "~anthropic/claude-haiku-latest", "claude-haiku-4.5"],
  ["claude-opus-latest", "~anthropic/claude-opus-latest", "claude-opus-5"],
  ["claude-fable-latest", "~anthropic/claude-fable-latest", "claude-fable-5"],
  ["grok-build-0.1", "x-ai/grok-build-0.1", "grok-build-0.1"],
  ["grok-latest", "~x-ai/grok-latest", "grok-4.5"],
  ["gemini-flash-lite-latest", "google/gemini-3.5-flash-lite", "gemini-flash-lite-latest"],
  ["gemini-flash-latest", "~google/gemini-flash-latest", "gemini-flash-latest"],
  ["gemini-pro-latest", "~google/gemini-pro-latest", "gemini-pro-latest"],
  ["mistral-large-latest", "mistralai/mistral-large", "mistral-large-latest"],
  ["mistral-medium-latest", "mistralai/mistral-medium-3.5", "mistral-medium-latest"],
  ["mistral-small-latest", "mistralai/mistral-small-2603", "mistral-small-latest"],
  ["kimi-latest", "~moonshotai/kimi-latest", "kimi-latest"],
  ["deepseek-flash-latest", "deepseek/deepseek-v4-flash", "deepseek-v4-flash"],
  ["deepseek-pro-latest", "deepseek/deepseek-v4-pro", "deepseek-v4-pro"],
  ["deepseek-r1", "deepseek/deepseek-r1", "deepseek-reasoner"],
  ["llama-3.3-70b-instruct", "meta-llama/llama-3.3-70b-instruct", "llama-3.3-70b-instruct"]
];

const ALIASES: Array<[string, string]> = [
  ["gpt-5.4-mini", "gpt-mini-latest"],
  ["claude-sonnet-5", "claude-sonnet-latest"],
  ["claude-haiku-4.5", "claude-haiku-latest"],
  ["claude-opus-5", "claude-opus-latest"],
  ["claude-fable-5", "claude-fable-latest"],
  ["grok-4.5", "grok-latest"],
  ["deepseek-v4-flash", "deepseek-flash-latest"],
  ["deepseek-v4-pro", "deepseek-pro-latest"],
  ["deepseek-reasoner", "deepseek-r1"],
  ["gemini-3.5-flash-lite", "gemini-flash-lite-latest"],
  ["google/gemini-3.7-flash", "gemini-flash-latest"],
  ["mistral-medium-3.5", "mistral-medium-latest"],
  ["mistral-medium-3-5", "mistral-medium-latest"]
];

describe("three-column LLM catalog", () => {
  let CURATED_LLM_MODEL_IDS: string[];
  let CATALOG_DISPLAY_SLUGS: readonly string[];
  let LLM_MODEL_CATALOG: ReadonlyArray<{ displaySlug: string }>;
  let displaySlugFor: (model: string | null | undefined) => string;
  let nativeSlugFor: (model: string | null | undefined) => string;
  let openRouterSlugFor: (model: string | null | undefined) => string;
  let nativeModelSlugForProvider: (model: string, family: "openai") => string;
  let normalizeOpenRouterModelId: (raw?: string) => string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let resolveLlmEndpoint: (...args: any[]) => { provider: string; model: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let upsertUserApiKey: (...args: any[]) => unknown;

  beforeAll(async () => {
    const { getDb } = await import("../src/lib/db");
    getDb();
    const dbApi = await import("../src/lib/db-api-keys");
    upsertUserApiKey = dbApi.upsertUserApiKey;
    const catalog = await import("../src/lib/llm-model-catalog");
    CATALOG_DISPLAY_SLUGS = catalog.CATALOG_DISPLAY_SLUGS;
    LLM_MODEL_CATALOG = catalog.LLM_MODEL_CATALOG;
    displaySlugFor = catalog.displaySlugFor;
    nativeSlugFor = catalog.nativeSlugFor;
    openRouterSlugFor = catalog.openRouterSlugFor;
    const ui = await import("../app/ui/llm-model-catalog");
    CURATED_LLM_MODEL_IDS = ui.CURATED_LLM_MODEL_IDS;
    const provider = await import("../src/lib/llm-provider");
    nativeModelSlugForProvider = provider.nativeModelSlugForProvider;
    normalizeOpenRouterModelId = provider.normalizeOpenRouterModelId;
    resolveLlmEndpoint = provider.resolveLlmEndpoint;
  });

  it("contains exactly the owner display slugs", () => {
    expect([...CATALOG_DISPLAY_SLUGS].sort()).toEqual(OWNER_ROWS.map(([display]) => display).sort());
    expect(new Set(CURATED_LLM_MODEL_IDS)).toEqual(new Set(CATALOG_DISPLAY_SLUGS));
    expect(new Set(LLM_MODEL_CATALOG.map((row) => row.displaySlug)).size).toBe(OWNER_ROWS.length);
  });

  it("resolves OpenRouter wire slugs (column 2) and native slugs (column 3)", () => {
    for (const [display, openRouter, native] of OWNER_ROWS) {
      expect(openRouterSlugFor(display), display).toBe(openRouter);
      expect(normalizeOpenRouterModelId(display), display).toBe(openRouter);
      expect(nativeSlugFor(display), display).toBe(native);
      expect(nativeModelSlugForProvider(display, "openai"), display).toBe(native);
    }
  });

  it("round-trips older persisted ids onto the new display slugs", () => {
    for (const [alias, display] of ALIASES) {
      expect(displaySlugFor(alias), alias).toBe(display);
      const row = OWNER_ROWS.find(([id]) => id === display)!;
      expect(normalizeOpenRouterModelId(alias), alias).toBe(row[1]);
      expect(nativeSlugFor(alias), alias).toBe(row[2]);
    }
  });

  it("never sends a display slug to OpenRouter when the wire slug differs", () => {
    expect(normalizeOpenRouterModelId("gpt-mini-latest")).toBe("~openai/gpt-mini-latest");
    expect(normalizeOpenRouterModelId("gemini-flash-lite-latest")).toBe("google/gemini-3.5-flash-lite");
    expect(normalizeOpenRouterModelId("deepseek-flash-latest")).toBe("deepseek/deepseek-v4-flash");
    expect(normalizeOpenRouterModelId("deepseek-r1")).toBe("deepseek/deepseek-r1");
    expect(normalizeOpenRouterModelId("mistral-small-latest")).toBe("mistralai/mistral-small-2603");
    expect(normalizeOpenRouterModelId("mistral-medium-latest")).toBe("mistralai/mistral-medium-3.5");
    expect(nativeSlugFor("openai/gpt-mini-latest")).toBe("gpt-5.4-mini");
    expect(nativeSlugFor("anthropic/claude-sonnet-latest")).toBe("claude-sonnet-5");
  });

  it("constructs live OpenRouter calls with the wire slug", () => {
    upsertUserApiKey("catalog-or-user", "openrouter", "sk-or-catalog-test");
    const endpoint = resolveLlmEndpoint({ llmModel: "gpt-mini-latest" }, "catalog-or-user");
    expect(endpoint.provider).toBe("openrouter");
    expect(endpoint.model).toBe("~openai/gpt-mini-latest");
    const aliased = resolveLlmEndpoint({ llmModel: "claude-sonnet-5" }, "catalog-or-user");
    expect(aliased.model).toBe("~anthropic/claude-sonnet-latest");
  });

  it("sends OpenRouter family-latest aliases with the required ~ prefix", () => {
    const latestWire = OWNER_ROWS
      .map(([, openRouter]) => openRouter)
      .filter((slug) => /-(?:latest)$/.test(slug.replace(/^~/, "").split("/")[1] ?? ""));
    expect(latestWire.length).toBeGreaterThan(0);
    for (const slug of latestWire) {
      expect(slug.startsWith("~"), slug).toBe(true);
    }
    expect(openRouterSlugFor("gemini-flash-latest:batch")).toBe("google/gemini-3.7-flash:batch");
    expect(normalizeOpenRouterModelId("google/gemini-3.6-flash:batch")).toBe("google/gemini-3.7-flash:batch");
  });
});
