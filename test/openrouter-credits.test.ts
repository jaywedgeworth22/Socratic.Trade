import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-orcredit-${randomUUID()}.db`)}`;
});

// A fake fetch that returns the OpenRouter /credits shape, and counts calls (for cache assertions).
function makeFetcher(body: unknown, opts: { ok?: boolean; status?: number } = {}) {
  const calls: string[] = [];
  const fetcher = (async (url: string) => {
    calls.push(String(url));
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      json: async () => body
    } as Response;
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

describe("openrouter credit status", () => {
  beforeEach(async () => {
    const { __resetOpenRouterCreditCache } = await import("../src/lib/openrouter-credits");
    __resetOpenRouterCreditCache();
    delete process.env.OPENROUTER_LOW_CREDIT_USD;
    delete process.env.OPENROUTER_CREDIT_CHECK_INTERVAL_MS;
  });

  it("returns null when no OpenRouter key is configured (no signal to publish)", async () => {
    const { getOpenRouterCreditStatus } = await import("../src/lib/openrouter-credits");
    const { fetcher } = makeFetcher({ data: { total_credits: 75, total_usage: 25 } });
    // Fresh DB, no key stored for local, failover off → resolves no key.
    expect(await getOpenRouterCreditStatus(1000, fetcher)).toBeNull();
  });

  it("ok=true when the balance is at/above the threshold; reports the remaining amount", async () => {
    const { upsertUserApiKey } = await import("../src/lib/db");
    upsertUserApiKey("local", "openrouter", "sk-or-test");
    process.env.OPENROUTER_LOW_CREDIT_USD = "10";
    const { getOpenRouterCreditStatus } = await import("../src/lib/openrouter-credits");
    const { fetcher } = makeFetcher({ data: { total_credits: 75, total_usage: 25.31 } });
    const s = (await getOpenRouterCreditStatus(1000, fetcher))!;
    expect(s.ok).toBe(true);
    expect(s.remainingUsd).toBeCloseTo(49.69, 2);
    expect(s.thresholdUsd).toBe(10);
  });

  it("ok=false ONLY when the balance is genuinely below the threshold (the alert signal)", async () => {
    const { upsertUserApiKey } = await import("../src/lib/db");
    upsertUserApiKey("local", "openrouter", "sk-or-test");
    process.env.OPENROUTER_LOW_CREDIT_USD = "10";
    const { getOpenRouterCreditStatus, __resetOpenRouterCreditCache } = await import("../src/lib/openrouter-credits");
    __resetOpenRouterCreditCache();
    const { fetcher } = makeFetcher({ data: { total_credits: 30, total_usage: 25.31 } }); // ~4.69 left
    const s = (await getOpenRouterCreditStatus(1000, fetcher))!;
    expect(s.ok).toBe(false);
    expect(s.remainingUsd).toBeCloseTo(4.69, 2);
  });

  it("fails OPEN on a read error — a broken credits check never masquerades as low balance", async () => {
    const { upsertUserApiKey } = await import("../src/lib/db");
    upsertUserApiKey("local", "openrouter", "sk-or-test");
    const { getOpenRouterCreditStatus, __resetOpenRouterCreditCache } = await import("../src/lib/openrouter-credits");
    __resetOpenRouterCreditCache();
    const { fetcher } = makeFetcher({}, { ok: false, status: 500 });
    const s = (await getOpenRouterCreditStatus(1000, fetcher))!;
    expect(s.ok).toBe(true); // fail-open — do NOT page on our own read failure
    expect(s.error).toContain("500");
    expect(s.remainingUsd).toBeNull();
  });

  it("caches within the interval — a frequent health poll does not hammer the credits API", async () => {
    const { upsertUserApiKey } = await import("../src/lib/db");
    upsertUserApiKey("local", "openrouter", "sk-or-test");
    process.env.OPENROUTER_CREDIT_CHECK_INTERVAL_MS = "600000";
    const { getOpenRouterCreditStatus, __resetOpenRouterCreditCache } = await import("../src/lib/openrouter-credits");
    __resetOpenRouterCreditCache();
    const { fetcher, calls } = makeFetcher({ data: { total_credits: 75, total_usage: 25 } });
    await getOpenRouterCreditStatus(1000, fetcher);
    await getOpenRouterCreditStatus(2000, fetcher); // within interval → served from cache
    expect(calls).toHaveLength(1);
    // After the interval elapses, it fetches again.
    await getOpenRouterCreditStatus(1000 + 600001, fetcher);
    expect(calls).toHaveLength(2);
  });
});
