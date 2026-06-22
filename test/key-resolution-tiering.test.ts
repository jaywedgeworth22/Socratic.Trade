// Tests for multi-user credential tiering: env API keys are the operator's keys, not a silent
// global fallback for tenants. per-user-only services (broker + LLM, and any unlisted service)
// serve env to `local` only; shared-operator-infra services (market data, RAG, macro, scraper)
// keep a global env fallback. LLM keys add an operator-funded failover with per-user usage tracking.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-tiering-${randomUUID()}.db`)}`;
});

describe("credential tiering — generic resolver", () => {
  it("per-user-only (alpaca): no env fallback for anyone; migrated into local's store at boot", async () => {
    vi.stubEnv("ALPACA_PAPER_API_KEY", "env-alpaca");
    const { resolveApiKeyWithSource, migrateLocalEnvCredentials } = await import("../src/lib/db");

    // No special `local` env branch — even the primary user does not get the env key from the resolver.
    expect(resolveApiKeyWithSource("alpaca_paper_api_key", "local").source).toBe("none");
    expect(resolveApiKeyWithSource("alpaca_paper_api_key", "u_tenant").source).toBe("none");

    // The boot migration moves the operator's env key into local's per-user store → resolves "user".
    expect(migrateLocalEnvCredentials().migrated).toContain("alpaca_paper_api_key");
    expect(resolveApiKeyWithSource("alpaca_paper_api_key", "local")).toMatchObject({ key: "env-alpaca", source: "user" });
    // A tenant still has nothing — `local` is not privileged, just migrated.
    expect(resolveApiKeyWithSource("alpaca_paper_api_key", "u_tenant").source).toBe("none");
  });

  it("a tenant's own stored key always wins over env", async () => {
    vi.stubEnv("ALPACA_PAPER_API_KEY", "env-alpaca");
    const { upsertUserApiKey, resolveApiKeyWithSource } = await import("../src/lib/db");
    upsertUserApiKey("u_tenant", "alpaca_paper_api_key", "tenant-key");
    expect(resolveApiKeyWithSource("alpaca_paper_api_key", "u_tenant")).toMatchObject({ key: "tenant-key", source: "user" });
  });

  it("shared-operator-infra (market data): env serves ANY user", async () => {
    vi.stubEnv("FINNHUB_API_KEY", "env-finnhub");
    const { resolveApiKeyWithSource } = await import("../src/lib/db");
    expect(resolveApiKeyWithSource("finnhub", "local").source).toBe("env");
    expect(resolveApiKeyWithSource("finnhub", "u_tenant")).toMatchObject({ key: "env-finnhub", source: "env" });
    expect(resolveApiKeyWithSource("finnhub", undefined).source).toBe("env");
  });

  it("an unlisted service defaults to per-user-only (fail closed for a tenant)", async () => {
    vi.stubEnv("FRED_API_KEY", "env-fred"); // fred IS shared — control
    const { resolveApiKeyWithSource, credTierForService } = await import("../src/lib/db");
    expect(credTierForService("some_new_provider")).toBe("per-user-only");
    expect(credTierForService("finnhub")).toBe("shared-operator-infra");
    // fred (shared) serves the tenant; an unknown per-user-only service would not.
    expect(resolveApiKeyWithSource("fred", "u_tenant").source).toBe("env");
  });
});

describe("LLM credential — operator-funded failover", () => {
  it("a tenant's own key wins (source=user)", async () => {
    vi.stubEnv("OPENAI_API_KEY", "env-openai");
    const { upsertUserApiKey, resolveLlmCredential } = await import("../src/lib/db");
    upsertUserApiKey("u_tenant", "openai", "tenant-openai");
    expect(resolveLlmCredential("openai", "u_tenant")).toEqual({ key: "tenant-openai", source: "user" });
  });

  it("any user (incl. local) without their own key uses the operator failover when ON (default)", async () => {
    vi.stubEnv("OPENAI_API_KEY", "env-openai");
    const { resolveLlmCredential } = await import("../src/lib/db");
    // No local carve-out — local and tenants alike reach the operator-funded failover.
    expect(resolveLlmCredential("openai", "local")).toEqual({ key: "env-openai", source: "operator" });
    expect(resolveLlmCredential("openai", "u_tenant")).toEqual({ key: "env-openai", source: "operator" });
  });

  it("with the failover OFF, every user (incl. local) needs their own key", async () => {
    vi.stubEnv("OPENAI_API_KEY", "env-openai");
    vi.stubEnv("LLM_OPERATOR_FALLBACK", "off");
    const { resolveLlmCredential, upsertUserApiKey } = await import("../src/lib/db");
    // No local special case: with the failover off and no stored key, even local fails closed.
    expect(resolveLlmCredential("openai", "u_tenant")).toEqual({ source: "none" });
    expect(resolveLlmCredential("openai", "local")).toEqual({ source: "none" });
    // A stored key works for either (this is what the boot migration gives local).
    upsertUserApiKey("local", "openai", "local-openai");
    expect(resolveLlmCredential("openai", "local")).toEqual({ key: "local-openai", source: "user" });
  });
});

describe("LLM usage ledger", () => {
  it("extractLlmUsage normalizes OpenAI and Anthropic usage shapes", async () => {
    const { extractLlmUsage } = await import("../src/lib/llm-usage");
    expect(extractLlmUsage({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    expect(extractLlmUsage({ usage: { input_tokens: 7, output_tokens: 3 } })).toEqual({ promptTokens: 7, completionTokens: 3, totalTokens: 10 });
    expect(extractLlmUsage({})).toEqual({});
  });

  it("records per-user usage and isolates operator-funded tenant spend", async () => {
    const { recordLlmUsage, getLlmUsageSummary } = await import("../src/lib/llm-usage");
    recordLlmUsage({ userId: "local", provider: "openai", model: "gpt-4o-mini", context: "strategy", keySource: "user", promptTokens: 1000, completionTokens: 500 });
    recordLlmUsage({ userId: "u_tenant", provider: "openai", model: "gpt-4o-mini", context: "chat", keySource: "operator", promptTokens: 2000, completionTokens: 1000 });

    const all = getLlmUsageSummary();
    expect(all.length).toBe(2);

    const operatorFunded = getLlmUsageSummary({ operatorFundedOnly: true });
    expect(operatorFunded.length).toBe(1);
    expect(operatorFunded[0].userId).toBe("u_tenant");
    expect(operatorFunded[0].calls).toBe(1);
    expect(operatorFunded[0].totalTokens).toBe(3000);
    expect(operatorFunded[0].costUsd).toBeGreaterThan(0); // gpt-4o-mini is priced
  });

  it("end-to-end: an LLM run() records a usage row with the userId + keySource it was built with", async () => {
    const { OpenAILLM } = await import("../src/lib/chat/llm");
    const { getLlmUsageSummary } = await import("../src/lib/llm-usage");

    // Transport that returns a usage block (operator-funded tenant call).
    const transport = async () => ({
      choices: [{ message: { content: "ack" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 120, completion_tokens: 30 }
    });
    const llm = new OpenAILLM("sk-test", "gpt-4o-mini", transport, { userId: "u_tenant", keySource: "operator", context: "chat" });
    await llm.run({ system: "s", message: "hi", tools: [], executeTool: async () => ({}), history: [] });

    const rows = getLlmUsageSummary();
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ userId: "u_tenant", provider: "openai", keySource: "operator", promptTokens: 120, completionTokens: 30 });
  });
});
