import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../src/lib/db";
import { makeOrchestrator } from "../src/lib/chat/orchestrator";
import { MockLLM } from "../src/lib/chat/llm";
import { listTurns } from "../src/lib/chat-history";
import { listMemories } from "../src/lib/memory/store";
import { addToWatchlist } from "../src/lib/watchlist";
import { createAlert as alertsCreateAlert } from "../src/lib/alerts";
import type { ToolDeps } from "../src/lib/chat/tools";
import type { ChatLLM } from "../src/lib/chat/types";

const deps: ToolDeps = {
  getQuote: async (symbol) => ({ symbol, price_usd: 200, change_pct: 1.2, as_of: "2024-01-15T00:00:00Z", source: "stub", session: "regular" }),
  searchKnowledge: async () => [],
  createAlert: (userId, input) => {
    const r = alertsCreateAlert(userId, input);
    return "error" in r ? r : { symbol: r.symbol, op: r.op, price: r.price };
  },
  watchlistAdd: (userId, symbol) => {
    try {
      return { ok: true, item: addToWatchlist(userId, symbol) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : "ERR" };
    }
  },
  accountLabel: "Test (local)"
};

describe("chat orchestrator (MockLLM)", () => {
  beforeAll(() => {
    process.env.DATABASE_URL = `file:${process.env.TMPDIR ?? "/tmp"}/chat-orch-test-${Date.now()}.db`;
    getDb();
  });

  const orchestrate = makeOrchestrator(deps, new MockLLM());

  it("quote turn is grounded (as_of + citation + disclaimer), no draft", async () => {
    const r = await orchestrate({ userId: "o1", message: "AAPL price" });
    expect(r.text).toMatch(/as of/i);
    expect(r.citations.length).toBeGreaterThan(0);
    expect(r.text).toContain("not personalized financial advice");
    expect(r.draft).toBeNull();
  });

  it("order intent drafts, never executes", async () => {
    const r = await orchestrate({ userId: "o2", message: "buy 10 AAPL at 200" });
    expect(r.draft).toBeTruthy();
    expect(r.draft!.executed).toBe(false);
    expect(r.text).not.toMatch(/\b(placed|executed|filled|submitted)\b/i);
  });

  it("persists user+assistant turns and ingests memory", async () => {
    await orchestrate({ userId: "o3", message: "no options ever" });
    expect(listTurns("o3").length).toBeGreaterThanOrEqual(2);
    expect(listMemories("o3").some((m) => m.subject === "no_options")).toBe(true);
  });
});

describe("chat orchestrator — NOW-tranche fixes (I1/I2/I3)", () => {
  beforeAll(() => {
    process.env.DATABASE_URL = `file:${process.env.TMPDIR ?? "/tmp"}/chat-orch-fixes-${Date.now()}.db`;
    getDb();
  });

  it("I1: a quote with no change/session is narrated WITHOUT a fabricated 0% or session", async () => {
    const noChangeDeps: ToolDeps = {
      ...deps,
      getQuote: async (symbol) => ({ symbol, price_usd: 200, as_of: "2024-01-15", source: "broker" })
    };
    const r = await makeOrchestrator(noChangeDeps, new MockLLM())({ userId: "f1", message: "AAPL price" });
    expect(r.text).toMatch(/as of/i);
    expect(r.text).not.toMatch(/\d+(\.\d+)?%/); // no fabricated percentage
    expect(r.text).not.toMatch(/session/i); // no fabricated session label
  });

  it("I2: the disclaimer is appended server-side even when the model omits it", async () => {
    const noDisclaimer: ChatLLM = { run: async () => ({ text: "Here is some neutral info.", toolCalls: [], citations: [] }) };
    const r = await makeOrchestrator(deps, noDisclaimer)({ userId: "f2", message: "what is a stock?" });
    expect(r.text).toContain("Here is some neutral info.");
    expect(r.text).toContain("not personalized financial advice");
  });

  it("I3: prior turns are replayed to the model on the next turn (multi-turn memory)", async () => {
    let captured: Array<{ role: string; text: string }> = [];
    const recorder: ChatLLM = {
      run: async (a) => {
        captured = (a.history ?? []).map((h) => ({ role: h.role, text: h.text }));
        return { text: "ok", toolCalls: [], citations: [] };
      }
    };
    const orch = makeOrchestrator(deps, recorder);
    await orch({ userId: "f3", message: "my first message here" });
    expect(captured.length).toBe(0); // first turn: no prior history
    await orch({ userId: "f3", message: "my second message" });
    expect(captured.length).toBeGreaterThanOrEqual(2); // user1 + assistant1
    expect(captured.some((h) => h.text.includes("my first message here"))).toBe(true);
    expect(captured[0]!.role).toBe("user"); // history must start with a user turn (Anthropic requirement)
  });
});
