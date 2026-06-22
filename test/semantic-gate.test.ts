// Tests for the SECOND-LAYER learned-context classifier: the semantic gate + templated-fact allowlist
// (src/lib/learned-context/semantic-gate.ts) and its async integration through ingestLearned
// (src/lib/learned-context/store.ts).
//
// The gate is STRICTLY ADDITIVE. These tests pin the four invariants that make it safe:
//   1. It UPGRADES keyword-dodging paraphrases (keyword 'fact') to 'risk' when the LLM says 'risk'.
//   2. It NEVER spends an LLM call on a templated fact or on a keyword-flagged risk (call-count = 0).
//   3. It FAILS SAFE: an LLM that throws falls back to the keyword result ('fact' stays 'fact').
//   4. With the flag OFF it never calls the LLM — behavior is keyword + allowlist only.
// Plus an end-to-end ingest check: an autonomous candidate the gate upgrades lands in the PENDING
// queue (human confirmation), not the advisory fact store.
//
// All offline: we inject a deterministic, call-counting MockLLM (the same injectable-LLM approach the
// chat tests use) so no API key or network is touched.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, listLearnedContext, listPendingLearnedContext } from "../src/lib/db";
import { classifyRiskTier } from "../src/lib/learned-context/classify";
import { classifyWithSemanticGate, matchesTemplatedFact } from "../src/lib/learned-context/semantic-gate";
import { ingestLearned } from "../src/lib/learned-context/store";
import type { ChatLLM, LlmResult } from "../src/lib/chat/types";
import type { LearnedContextCandidate } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${process.env.TMPDIR ?? "/tmp"}/semantic-gate-test-${Date.now()}.db`;
  getDb();
});

// Default the flag ON for this suite; individual tests override as needed and beforeEach restores it.
beforeEach(() => {
  process.env.LEARNED_CONTEXT_SEMANTIC_GATE = "on";
});
afterEach(() => {
  process.env.LEARNED_CONTEXT_SEMANTIC_GATE = "on";
});

/**
 * Deterministic, call-counting LLM stand-in. `verdict`:
 *   - "risk"/"fact" → returns the strict JSON the gate parses.
 *   - "garbage"     → returns unparseable text (exercises the fail-safe).
 *   - "throw"       → throws (exercises the LLM-unavailable fail-safe).
 */
class CountingMockLLM implements ChatLLM {
  public calls = 0;
  constructor(private verdict: "risk" | "fact" | "garbage" | "throw") {}
  async run(): Promise<LlmResult> {
    this.calls += 1;
    if (this.verdict === "throw") throw new Error("LLM unavailable");
    if (this.verdict === "garbage") return { text: "I think maybe this could be risky?", toolCalls: [], citations: [] };
    return { text: `{"tier":"${this.verdict}"}`, toolCalls: [], citations: [] };
  }
}

const cand = (overrides: Partial<LearnedContextCandidate>): LearnedContextCandidate => ({
  kind: "pattern",
  subject: "obs",
  value: "",
  ...overrides
});

// Keyword-DODGING paraphrases: classifyRiskTier returns 'fact' for these (no blocklist hit), yet they
// clearly touch risk tolerance / sizing — exactly what the semantic gate must catch. (Each is asserted
// to be keyword-'fact' first, so the gate's LLM call is genuinely the thing being exercised.)
const PARAPHRASES = [
  "comfortable with much bigger swings now",
  "let the winners run a good while longer",
  "no need to be cautious on this one"
];

describe("semantic gate — UPGRADES keyword-dodging paraphrases to 'risk'", () => {
  for (const phrase of PARAPHRASES) {
    it(`"${phrase}" → 'risk' when the LLM says risk`, async () => {
      // Guard: prove the KEYWORD layer alone misses this (returns 'fact') — so the upgrade to 'risk'
      // is genuinely the semantic gate's doing, not the blocklist's.
      expect(classifyRiskTier(cand({ subject: "tone", value: phrase, intent: phrase }))).toBe("fact");
      const llm = new CountingMockLLM("risk");
      const tier = await classifyWithSemanticGate(cand({ subject: "tone", value: phrase, intent: phrase }), { llm });
      expect(tier).toBe("risk");
      expect(llm.calls).toBe(1); // the gate DID consult the LLM for this non-allowlisted fact
    });
  }

  it("keeps 'fact' when the LLM says fact (no spurious upgrade)", async () => {
    const llm = new CountingMockLLM("fact");
    const tier = await classifyWithSemanticGate(cand({ subject: "obs", value: "the CEO has been in the role 12 years" }), { llm });
    expect(tier).toBe("fact");
    expect(llm.calls).toBe(1);
  });
});

describe("templated-fact ALLOWLIST — definitively 'fact', LLM NOT called", () => {
  const TEMPLATED = [
    { subject: "fact:ASML", value: "ASML is the sole EUV supplier" },
    { subject: "fact:NVDA", value: "NVDA is in the S&P 500" },
    { subject: "fact:AAPL", value: "AAPL is a member of the Nasdaq 100" },
    { subject: "fact:MSFT", value: "MSFT reports earnings on the 24th" },
    { subject: "fact:TSLA", value: "TSLA is headquartered in Austin" }
  ];
  for (const t of TEMPLATED) {
    it(`"${t.value}" → 'fact' WITHOUT an LLM call`, async () => {
      expect(matchesTemplatedFact(cand(t))).toBe(true);
      const llm = new CountingMockLLM("risk"); // even if the LLM WOULD say risk, it must not be consulted
      const tier = await classifyWithSemanticGate(cand(t), { llm });
      expect(tier).toBe("fact");
      expect(llm.calls).toBe(0);
    });
  }
});

describe("keyword-flagged RISK — short-circuits, LLM NOT called", () => {
  it('"back up the truck on tech" → \'risk\' without consulting the LLM', async () => {
    const llm = new CountingMockLLM("fact"); // even a 'fact' verdict must NOT downgrade a keyword risk
    const tier = await classifyWithSemanticGate(
      cand({ subject: "tech", value: "back up the truck on tech", intent: "back up the truck on tech" }),
      { llm }
    );
    expect(tier).toBe("risk");
    expect(llm.calls).toBe(0);
  });

  it("a numeric sizing knob ('raise to 30%') stays 'risk' without an LLM call", async () => {
    const llm = new CountingMockLLM("fact");
    const tier = await classifyWithSemanticGate(cand({ subject: "max_position", value: "raise to 30%" }), { llm });
    expect(tier).toBe("risk");
    expect(llm.calls).toBe(0);
  });
});

describe("FAIL-SAFE — LLM error/garbage falls back to the keyword result", () => {
  it("LLM throws → falls back to keyword 'fact' (ingestion NOT blocked)", async () => {
    const llm = new CountingMockLLM("throw");
    const tier = await classifyWithSemanticGate(cand({ subject: "tone", value: "comfortable with much bigger swings now" }), { llm });
    expect(tier).toBe("fact");
    expect(llm.calls).toBe(1); // it tried, then degraded gracefully
  });

  it("LLM returns unparseable output → falls back to keyword 'fact'", async () => {
    const llm = new CountingMockLLM("garbage");
    const tier = await classifyWithSemanticGate(cand({ subject: "tone", value: "let the winners run a good while longer" }), { llm });
    expect(tier).toBe("fact");
    expect(llm.calls).toBe(1);
  });
});

describe("FLAG OFF — gate disabled, LLM never called", () => {
  it('LEARNED_CONTEXT_SEMANTIC_GATE="off" → keyword+allowlist only, no LLM call', async () => {
    process.env.LEARNED_CONTEXT_SEMANTIC_GATE = "off";
    const llm = new CountingMockLLM("risk");
    // A paraphrase the keyword layer calls 'fact' stays 'fact' because the gate is off.
    const tier = await classifyWithSemanticGate(cand({ subject: "tone", value: "no need to be cautious on this one" }), { llm });
    expect(tier).toBe("fact");
    expect(llm.calls).toBe(0);
  });

  it('with the flag off a keyword risk is still \'risk\' (allowlist + keyword preserved)', async () => {
    process.env.LEARNED_CONTEXT_SEMANTIC_GATE = "off";
    const llm = new CountingMockLLM("fact");
    const tier = await classifyWithSemanticGate(cand({ subject: "tech", value: "back up the truck on tech" }), { llm });
    expect(tier).toBe("risk");
    expect(llm.calls).toBe(0);
  });
});

describe("end-to-end ingest — gate-upgraded autonomous candidate lands in the PENDING queue", () => {
  it("an autonomous paraphrase the gate upgrades is QUEUED, not written to the fact store", async () => {
    const userId = "semgate-e2e-autonomous";
    const llm = new CountingMockLLM("risk");
    const r = await ingestLearned(
      userId,
      { kind: "pattern", subject: "risk_tone", value: "comfortable with much bigger swings now" },
      "autonomous",
      { llm }
    );
    // Routed to the human confirmation queue, NOT written as an advisory fact and NOT dropped.
    expect(r.tier).toBe("risk");
    expect(r.written).toBeNull();
    expect(r.dropped).toBeNull();
    expect(r.pendingId).not.toBeNull();
    expect(listPendingLearnedContext(userId, "pending").some((p) => p.subject === "risk_tone")).toBe(true);
    // It is NOT reachable by the brain as a fact.
    expect(listLearnedContext(userId).some((row) => row.subject === "risk_tone")).toBe(false);
  });

  it("CHAT hard-cap holds: a gate-upgraded CHAT candidate is DROPPED, never queued", async () => {
    const userId = "semgate-e2e-chat";
    const llm = new CountingMockLLM("risk");
    const before = listPendingLearnedContext(userId, "pending").length;
    const r = await ingestLearned(
      userId,
      { kind: "pattern", subject: "risk_tone", value: "comfortable with much bigger swings now" },
      "chat",
      { llm }
    );
    // The gate upgraded it to 'risk', but chat origin is hard-capped → dropped, NOT queued, NOT written.
    expect(r.tier).toBe("risk");
    expect(r.dropped).toBe("chat_risk_dropped");
    expect(r.pending).toBeNull();
    expect(r.pendingId).toBeNull();
    expect(r.written).toBeNull();
    expect(listPendingLearnedContext(userId, "pending").length).toBe(before);
    expect(listLearnedContext(userId).some((row) => row.subject === "risk_tone")).toBe(false);
  });
});
