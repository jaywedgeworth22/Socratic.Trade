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
  it("per-user-only (alpaca): no env fallback for anyone", async () => {
    vi.stubEnv("ALPACA_PAPER_API_KEY", "env-alpaca");
    const { resolveApiKeyWithSource } = await import("../src/lib/db");

    // No special `local` env branch — even the primary user does not get the env key from the resolver.
    expect(resolveApiKeyWithSource("alpaca_paper_api_key", "local").source).toBe("none");
    expect(resolveApiKeyWithSource("alpaca_paper_api_key", "u_tenant").source).toBe("none");
  });

  it("a tenant's own stored key always wins over env", async () => {
    vi.stubEnv("ALPACA_PAPER_API_KEY", "env-alpaca");
    const { upsertUserApiKey, resolveApiKeyWithSource } = await import("../src/lib/db");
    upsertUserApiKey("u_tenant", "alpaca_paper_api_key", "tenant-key");
    expect(resolveApiKeyWithSource("alpaca_paper_api_key", "u_tenant")).toMatchObject({ key: "tenant-key", source: "user" });
  });

  it("an unlisted service defaults to per-user-only (fail closed)", async () => {
    const { resolveApiKeyWithSource } = await import("../src/lib/db");
    expect(resolveApiKeyWithSource("some_new_provider", "u_tenant").source).toBe("none");
  });
});

describe("LLM credential — operator-funded failover removed", () => {
  it("a tenant's own key wins (source=user)", async () => {
    vi.stubEnv("OPENAI_API_KEY", "env-openai");
    const { upsertUserApiKey, resolveLlmCredential } = await import("../src/lib/db");
    upsertUserApiKey("u_tenant", "openai", "tenant-openai");
    expect(resolveLlmCredential("openai", "u_tenant")).toMatchObject({ key: "tenant-openai", source: "user" });
  });

  it("any user (incl. local) without their own key fails closed", async () => {
    vi.stubEnv("OPENAI_API_KEY", "env-openai");
    const { resolveLlmCredential, upsertUserApiKey } = await import("../src/lib/db");
    expect(resolveLlmCredential("openai", "u_tenant")).toEqual({ source: "none" });
    expect(resolveLlmCredential("openai", "local")).toEqual({ source: "none" });
    // A stored key works for either.
    upsertUserApiKey("local", "openai", "local-openai");
    expect(resolveLlmCredential("openai", "local")).toMatchObject({ key: "local-openai", source: "user" });
  });
});

describe("LLM usage ledger", () => {
  it("extractLlmUsage normalizes OpenAI and Anthropic usage shapes", async () => {
    const { extractLlmUsage } = await import("../src/lib/llm-usage");
    expect(extractLlmUsage({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    expect(extractLlmUsage({ usage: { input_tokens: 7, output_tokens: 3 } })).toEqual({ promptTokens: 7, completionTokens: 3, totalTokens: 10 });
    expect(extractLlmUsage({})).toEqual({});
  });

  it("records per-user usage", async () => {
    const { recordLlmUsage, getLlmUsageSummary } = await import("../src/lib/llm-usage");
    recordLlmUsage({ userId: "local", provider: "openai", model: "gpt-4o-mini", context: "strategy", keySource: "user", promptTokens: 1000, completionTokens: 500 });

    const all = getLlmUsageSummary();
    expect(all.length).toBe(1);
  });

  it("end-to-end: an LLM run() records a usage row with the userId + keySource it was built with", async () => {
    const { OpenAILLM } = await import("../src/lib/chat/llm");
    const { getLlmUsageSummary } = await import("../src/lib/llm-usage");

    // Transport that returns a usage block (operator-funded tenant call).
    const transport = async () => ({
      choices: [{ message: { content: "ack" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 120, completion_tokens: 30 }
    });
    const llm = new OpenAILLM("sk-test", "gpt-4o-mini", transport, { userId: "u_tenant", keySource: "user", context: "chat" });
    await llm.run({ system: "s", message: "hi", tools: [], executeTool: async () => ({}), history: [] });

    const rows = getLlmUsageSummary();
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ userId: "u_tenant", provider: "openai", keySource: "user", promptTokens: 120, completionTokens: 30 });
  });

  it("attributes usage PER ATTACHED KEY via a non-secret fingerprint", async () => {
    const { resolveLlmCredential, upsertUserApiKey } = await import("../src/lib/db");
    const { recordLlmUsage, getLlmUsageSummary, keyFingerprint } = await import("../src/lib/llm-usage");

    upsertUserApiKey("u_tenant", "openai", "tenant-own-key");
    const own = resolveLlmCredential("openai", "u_tenant"); // user's own key
    expect(own.keyRef).toBe(keyFingerprint("tenant-own-key"));
    expect(own.keyRef).not.toContain("tenant-own-key"); // fingerprint, not the secret

    // One call on the tenant's own key → grouped per key.
    recordLlmUsage({ userId: "u_tenant", provider: "openai", model: "gpt-4o-mini", keySource: "user", keyRef: own.keyRef, promptTokens: 50, completionTokens: 5 });

    const byKey = getLlmUsageSummary();
    const ownRows = byKey.filter((r) => r.keyRef === own.keyRef);
    expect(ownRows.reduce((s, r) => s + r.calls, 0)).toBe(1);
    expect(byKey.every((r) => r.keyRef !== null)).toBe(true);
  });

  it("describeUsageKey resolves a human label (last-4 + name) from the live key store", async () => {
    const { upsertUserApiKey } = await import("../src/lib/db");
    const { describeUsageKey, keyFingerprint } = await import("../src/lib/llm-usage");

    upsertUserApiKey("u_tenant", "openai", "tenant-own-key-WXYZ");
    upsertUserApiKey("local", "openai", "local-key-7788");

    // A tenant's own key → labeled by user + last-4.
    expect(describeUsageKey({ keyRef: keyFingerprint("tenant-own-key-WXYZ")!, userId: "u_tenant", provider: "openai" })).toEqual({
      last4: "WXYZ",
      masked: "tenant-o...WXYZ",
      label: "u_tenant (openai)"
    });
    expect(describeUsageKey({ keyRef: keyFingerprint("local-key-7788")!, userId: "local", provider: "openai" })).toEqual({
      last4: "7788",
      masked: "local-ke...7788",
      label: "primary user (openai)"
    });
    // A detached/unknown key (no longer in the store) → no label, fingerprint still in the ledger.
    expect(describeUsageKey({ keyRef: keyFingerprint("deleted-key")!, userId: "u_tenant", provider: "openai" })).toBeUndefined();
    expect(describeUsageKey({ keyRef: null, userId: "u_tenant", provider: "openai" })).toBeUndefined();
  });
});

describe("Alpaca market-data credential (shared data, per-user trading)", () => {
  it("a user's own Alpaca key gives individual data", async () => {
    const { resolveAlpacaMarketData, upsertUserApiKey } = await import("../src/lib/db");

    // A tenant with no own key → fails
    expect(resolveAlpacaMarketData("u_tenant").source).toBe("none");

    // A tenant WITH their own key → their individual data (source "user", private/pooled).
    upsertUserApiKey("u_tenant", "alpaca_paper_api_key", "tenant-alpaca-key");
    upsertUserApiKey("u_tenant", "alpaca_paper_secret_key", "tenant-alpaca-secret");
    expect(resolveAlpacaMarketData("u_tenant")).toMatchObject({ apiKey: "tenant-alpaca-key", secretKey: "tenant-alpaca-secret", source: "user" });
  });

  it("resolves from connected_accounts if present, preferring active and live", async () => {
    const { resolveAlpacaMarketData, upsertConnectedAccount } = await import("../src/lib/db");

    // Add a paper account (inactive)
    upsertConnectedAccount({
      id: "acc-paper",
      userId: "u_tenant",
      broker: "alpaca",
      environment: "paper",
      accountNumber: "PA-TEST-1",
      label: "Paper Acc",
      apiKey: "conn-paper-key",
      apiSecret: "conn-paper-secret",
      isActive: false
    });

    // Add a live account (inactive)
    upsertConnectedAccount({
      id: "acc-live",
      userId: "u_tenant",
      broker: "alpaca",
      environment: "live",
      accountNumber: "LA-TEST-1",
      label: "Live Acc",
      apiKey: "conn-live-key",
      apiSecret: "conn-live-secret",
      isActive: false
    });

    // Should prefer live over paper when neither is active
    expect(resolveAlpacaMarketData("u_tenant")).toMatchObject({
      apiKey: "conn-live-key",
      secretKey: "conn-live-secret",
      source: "user"
    });

    // Now make the paper account active (re-upserting changes active status)
    upsertConnectedAccount({
      id: "acc-paper",
      userId: "u_tenant",
      broker: "alpaca",
      environment: "paper",
      accountNumber: "PA-TEST-1",
      label: "Paper Acc",
      apiKey: "conn-paper-key",
      apiSecret: "conn-paper-secret",
      isActive: true
    });

    // Should prefer active over live
    expect(resolveAlpacaMarketData("u_tenant")).toMatchObject({
      apiKey: "conn-paper-key",
      secretKey: "conn-paper-secret",
      source: "user"
    });
  });

  it("uses the operator connected Alpaca account for shared background and tenant market data", async () => {
    const { resolveAlpacaMarketData, upsertConnectedAccount } = await import("../src/lib/db");

    upsertConnectedAccount({
      id: "local-alpaca",
      userId: "local",
      broker: "alpaca",
      environment: "paper",
      accountNumber: "PA-LOCAL",
      label: "Operator Paper",
      apiKey: "local-connected-key",
      apiSecret: "local-connected-secret",
      isActive: true
    });

    expect(resolveAlpacaMarketData("local")).toMatchObject({
      apiKey: "local-connected-key",
      secretKey: "local-connected-secret",
      source: "user"
    });
  });

  it("falls through incomplete tenant Alpaca credentials to the operator shared account", async () => {
    const { resolveAlpacaMarketData, upsertConnectedAccount } = await import("../src/lib/db");

    upsertConnectedAccount({
      id: "tenant-oauth-only",
      userId: "u_tenant",
      broker: "alpaca",
      environment: "paper",
      accountNumber: "PA-TENANT",
      label: "Tenant OAuth",
      apiKey: "tenant-oauth-token",
      isActive: true
    });

    upsertConnectedAccount({
      id: "local-alpaca",
      userId: "local",
      broker: "alpaca",
      environment: "paper",
      accountNumber: "PA-LOCAL",
      label: "Operator Paper",
      apiKey: "local-connected-key",
      apiSecret: "local-connected-secret",
      isActive: true
    });

    expect(resolveAlpacaMarketData("u_tenant")).toMatchObject({
      apiKey: "tenant-oauth-token",
      source: "user"
    });
  });

  it("preserves a tenant key-only Alpaca credential when no shared fallback exists", async () => {
    const { resolveAlpacaMarketData, upsertConnectedAccount } = await import("../src/lib/db");

    upsertConnectedAccount({
      id: "tenant-oauth-only",
      userId: "u_tenant",
      broker: "alpaca",
      environment: "paper",
      accountNumber: "PA-TENANT",
      label: "Tenant OAuth",
      apiKey: "tenant-oauth-token",
      isActive: true
    });

    expect(resolveAlpacaMarketData("u_tenant")).toMatchObject({
      apiKey: "tenant-oauth-token",
      source: "user"
    });
    expect(resolveAlpacaMarketData("u_tenant").secretKey).toBeUndefined();
  });

  it("preserves a tenant key-only Alpaca credential over an operator key-only connected account", async () => {
    const { resolveAlpacaMarketData, upsertConnectedAccount } = await import("../src/lib/db");

    upsertConnectedAccount({
      id: "tenant-oauth-only",
      userId: "u_tenant",
      broker: "alpaca",
      environment: "paper",
      accountNumber: "PA-TENANT",
      label: "Tenant OAuth",
      apiKey: "tenant-oauth-token",
      isActive: true
    });
    upsertConnectedAccount({
      id: "local-oauth-only",
      userId: "local",
      broker: "alpaca",
      environment: "paper",
      accountNumber: "PA-LOCAL",
      label: "Operator OAuth",
      apiKey: "local-oauth-token",
      isActive: true
    });

    expect(resolveAlpacaMarketData("u_tenant")).toMatchObject({
      apiKey: "tenant-oauth-token",
      source: "user"
    });
    expect(resolveAlpacaMarketData("u_tenant").secretKey).toBeUndefined();
  });

  it("checks another connected Alpaca account before falling back from a key-only preferred account", async () => {
    const { resolveAlpacaMarketData, upsertConnectedAccount } = await import("../src/lib/db");

    upsertConnectedAccount({
      id: "tenant-live-oauth-only",
      userId: "u_tenant",
      broker: "alpaca",
      environment: "live",
      accountNumber: "LA-TENANT",
      label: "Tenant Live OAuth",
      apiKey: "tenant-live-token",
      isActive: true
    });
    upsertConnectedAccount({
      id: "tenant-paper-complete",
      userId: "u_tenant",
      broker: "alpaca",
      environment: "paper",
      accountNumber: "PA-TENANT",
      label: "Tenant Paper",
      apiKey: "tenant-paper-key",
      apiSecret: "tenant-paper-secret",
      isActive: true
    });

    expect(resolveAlpacaMarketData("u_tenant")).toMatchObject({
      apiKey: "tenant-paper-key",
      secretKey: "tenant-paper-secret",
      source: "user"
    });
  });

  it("preserves an operator key-only connected Alpaca credential for shared news enrichment", async () => {
    const { resolveAlpacaMarketData, upsertConnectedAccount } = await import("../src/lib/db");

    upsertConnectedAccount({
      id: "local-oauth-only",
      userId: "local",
      broker: "alpaca",
      environment: "paper",
      accountNumber: "PA-LOCAL",
      label: "Operator OAuth",
      apiKey: "local-oauth-token",
      isActive: true
    });

    expect(resolveAlpacaMarketData("local")).toMatchObject({
      apiKey: "local-oauth-token",
      source: "user"
    });
    expect(resolveAlpacaMarketData("local").secretKey).toBeUndefined();
  });

  it("prefers an operator connected key-only Alpaca credential over stored operator keys for news", async () => {
    const { resolveAlpacaMarketData, upsertConnectedAccount, upsertUserApiKey } = await import("../src/lib/db");

    upsertConnectedAccount({
      id: "local-oauth-current",
      userId: "local",
      broker: "alpaca",
      environment: "paper",
      accountNumber: "PA-LOCAL",
      label: "Operator OAuth",
      apiKey: "local-current-token",
      isActive: true
    });
    upsertUserApiKey("local", "alpaca_paper_api_key", "stale-operator-key");
    upsertUserApiKey("local", "alpaca_paper_secret_key", "stale-operator-secret");

    expect(resolveAlpacaMarketData("local")).toMatchObject({
      apiKey: "local-current-token",
      source: "user"
    });
    expect(resolveAlpacaMarketData("local").secretKey).toBeUndefined();
  });

  it("ignores Alpaca MCP connected accounts for REST market-data resolution", async () => {
    vi.stubEnv("ALPACA_PAPER_API_KEY", "op-alpaca-key");
    vi.stubEnv("ALPACA_PAPER_SECRET_KEY", "op-alpaca-secret");
    const { resolveAlpacaMarketData, upsertConnectedAccount } = await import("../src/lib/db");

    upsertConnectedAccount({
      id: "local-alpaca-mcp",
      userId: "local",
      broker: "alpaca-mcp",
      environment: "paper",
      accountNumber: "MCP-LOCAL",
      label: "Operator MCP",
      apiKey: "mcp-token",
      apiSecret: "mcp-secret",
      isActive: true
    });

    expect(resolveAlpacaMarketData("local").source).toBe("none");
  });

  it("trading resolution is unaffected — a tenant never gets the operator's Alpaca key to trade", async () => {
    vi.stubEnv("ALPACA_PAPER_API_KEY", "op-alpaca-key");
    const { resolveApiKeyWithSource } = await import("../src/lib/db");
    // The trading path (alpaca.ts uses resolveApiKey, per-user-only) fails closed for a tenant.
    expect(resolveApiKeyWithSource("alpaca_paper_api_key", "u_tenant").source).toBe("none");
  });
});

describe("resolveAlpacaStreamAccount (background WebSocket stream workers)", () => {
  it("prefers the active connected Alpaca account and reports its real environment", async () => {
    const { resolveAlpacaStreamAccount, upsertConnectedAccount } = await import("../src/lib/db");

    upsertConnectedAccount({
      id: "local-alpaca-live",
      userId: "local",
      broker: "alpaca",
      environment: "live",
      accountNumber: "LIVE-1",
      label: "Live Acc",
      apiKey: "live-key",
      apiSecret: "live-secret",
      isActive: true
    });

    expect(resolveAlpacaStreamAccount("local")).toMatchObject({
      apiKey: "live-key",
      apiSecret: "live-secret",
      environment: "live"
    });
  });

  it("falls back to the legacy standalone key pair (as 'paper') when no connected Alpaca account exists", async () => {
    const { resolveAlpacaStreamAccount, upsertUserApiKey } = await import("../src/lib/db");
    upsertUserApiKey("local", "alpaca_paper_api_key", "legacy-key");
    upsertUserApiKey("local", "alpaca_paper_secret_key", "legacy-secret");

    expect(resolveAlpacaStreamAccount("local")).toMatchObject({
      apiKey: "legacy-key",
      apiSecret: "legacy-secret",
      environment: "paper"
    });
  });

  it("does not use a stale legacy key when a connected account is active — regression for the production incident", async () => {
    // Production incident: the legacy alpaca_paper_api_key/secret pair went stale (last
    // touched 2026-06-22) after the user rotated keys via Settings -> Accounts on 2026-06-29,
    // which only updates connected_accounts. The stream workers used to read the stale legacy
    // pair exclusively and got HTTP 401 from Alpaca. The active connected account must win.
    const { resolveAlpacaStreamAccount, upsertConnectedAccount, upsertUserApiKey } = await import("../src/lib/db");
    upsertUserApiKey("local", "alpaca_paper_api_key", "stale-legacy-key");
    upsertUserApiKey("local", "alpaca_paper_secret_key", "stale-legacy-secret");
    upsertConnectedAccount({
      id: "local-alpaca-fresh",
      userId: "local",
      broker: "alpaca",
      environment: "live",
      accountNumber: "FRESH-1",
      label: "Fresh Acc",
      apiKey: "fresh-key",
      apiSecret: "fresh-secret",
      isActive: true
    });

    expect(resolveAlpacaStreamAccount("local")).toMatchObject({
      apiKey: "fresh-key",
      apiSecret: "fresh-secret",
      environment: "live"
    });
  });

  it("returns undefined when neither a connected Alpaca account nor a legacy key exists", async () => {
    const { resolveAlpacaStreamAccount } = await import("../src/lib/db");
    expect(resolveAlpacaStreamAccount("brand-new-user")).toBeUndefined();
  });

  it("prefers a connected Alpaca account over legacy keys even when another broker is active", async () => {
    const { resolveAlpacaStreamAccount, upsertConnectedAccount, upsertUserApiKey } = await import("../src/lib/db");
    upsertUserApiKey("local", "alpaca_paper_api_key", "stale-legacy-key");
    upsertUserApiKey("local", "alpaca_paper_secret_key", "stale-legacy-secret");
    upsertConnectedAccount({
      id: "local-robinhood",
      userId: "local",
      broker: "robinhood",
      environment: "live",
      accountNumber: "RH-1",
      label: "Robinhood Acc",
      isActive: true
    });
    upsertConnectedAccount({
      id: "local-alpaca-inactive",
      userId: "local",
      broker: "alpaca",
      environment: "live",
      accountNumber: "ALPACA-1",
      label: "Alpaca Acc",
      apiKey: "fresh-connected-key",
      apiSecret: "fresh-connected-secret",
      isActive: false
    });

    expect(resolveAlpacaStreamAccount("local")).toMatchObject({
      apiKey: "fresh-connected-key",
      apiSecret: "fresh-connected-secret",
      environment: "live"
    });
  });
});
