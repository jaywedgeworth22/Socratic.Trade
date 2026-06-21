import { beforeAll, describe, expect, it } from "vitest";
import {
  getDb,
  insertLearnedContext,
  listLearnedContext,
  listLearnedContextForDecision,
  listAudit
} from "../src/lib/db";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { applyDeterministicSizing } from "../src/lib/strategy";
import { classifyRiskTier } from "../src/lib/learned-context/classify";
import { ingestLearned, retrieveLearnedContext } from "../src/lib/learned-context/store";
import { extractLearnedCandidates } from "../src/lib/memory/salience";
import type {
  EquityPosition,
  LearnedContextRow,
  Portfolio,
  TradeProposal,
  TradingPolicy
} from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${process.env.TMPDIR ?? "/tmp"}/learned-context-test-${Date.now()}.db`;
  getDb();
});

// ── fixtures ───────────────────────────────────────────────────────────────────
const policy: TradingPolicy = { ...DEFAULT_POLICY, accountNumber: "TEST-ACCT" };

const portfolio: Portfolio = {
  accountNumber: "TEST-ACCT",
  totalMarketValue: 100_000,
  buyingPower: 50_000,
  equityMarketValue: 100_000,
  optionMarketValue: 0,
  cash: 50_000
};

const buyProposal: TradeProposal = {
  symbol: "NVDA",
  side: "buy",
  type: "market",
  timeInForce: "gfd",
  marketHours: "regular_hours",
  rationale: "Strong momentum",
  tradeThesisTag: "Momentum-Breakout",
  entryMarketRegime: "Tech-Bull",
  confidenceScore: 70
};

const positions: EquityPosition[] = [];

function makeRow(overrides: Partial<LearnedContextRow>): LearnedContextRow {
  return {
    id: `row-${Math.random().toString(36).slice(2)}`,
    userId: "safety-user",
    scope: "private",
    kind: "fact",
    subject: "fact:NVDA",
    symbol: "NVDA",
    value: "NVDA dominates the AI accelerator market.",
    source: "inferred",
    origin: "ingest",
    riskTier: "fact",
    confidence: 0.6,
    contributorUserId: "safety-user",
    assertedAt: new Date().toISOString(),
    supersededBy: null,
    expiresAt: null,
    ...overrides
  };
}

// ── PHASE 0: the safety invariant (the entire safety guarantee) ─────────────────
describe("PHASE 0 — learned_context is advisory-only, never an input to sizing/weights", () => {
  it("applyDeterministicSizing output is byte-identical with or without learned_context rows", () => {
    // Baseline sizing in a DB with NO learned_context rows for this user.
    const before = applyDeterministicSizing(buyProposal, policy, portfolio, "paper", "safety-user", positions);

    // Now flood the table with learned_context rows whose contents — if they ever leaked into
    // sizing — would obviously move the result (huge percents, "increase size", risk subjects).
    insertLearnedContext(makeRow({ subject: "max_position_pct", value: "increase to 99%", riskTier: "fact" }));
    insertLearnedContext(makeRow({ subject: "position sizing", value: "be far more aggressive, size up 10x" }));
    insertLearnedContext(makeRow({ subject: "fact:NVDA", value: "lean much harder into NVDA at 100%" }));
    insertLearnedContext(makeRow({ subject: "scoringWeight:momentum", value: "1000" }));

    const after = applyDeterministicSizing(buyProposal, policy, portfolio, "paper", "safety-user", positions);

    // The structural guarantee: sizing depends ONLY on (proposal, policy, portfolio, scorecards).
    // It has no parameter through which learned_context could flow, so the two outputs must match
    // exactly. If a future change threads learned_context into sizing, this assertion fails loudly.
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it("applyDeterministicSizing signature exposes no learned_context channel", () => {
    // applyDeterministicSizing(proposal, policy, portfolio, source, userId, positions) — 6 params.
    // A 7th param (or an object grab-bag) would be the seam a leak could enter through.
    expect(applyDeterministicSizing.length).toBeLessThanOrEqual(6);
  });

  it("retrieveLearnedContext returns advisory STRINGS only — never numeric sizing data", () => {
    const facts = retrieveLearnedContext("safety-user", ["NVDA"]);
    expect(Array.isArray(facts)).toBe(true);
    for (const f of facts) {
      expect(typeof f).toBe("string");
    }
  });
});

// ── PHASE 2: the fail-closed classifier (the single chokepoint) ─────────────────
describe("PHASE 2 — classifyRiskTier is fail-closed", () => {
  it("classifies a clean structural fact as 'fact'", () => {
    expect(
      classifyRiskTier({ kind: "decision", subject: "fact:ASML", value: "ASML is the sole EUV lithography supplier." })
    ).toBe("fact");
  });

  it("the Safety-judge example 'lean much harder into tech' (no numeric) classifies as RISK", () => {
    expect(
      classifyRiskTier({ kind: "pattern", subject: "tech", value: "lean much harder into tech", intent: "lean much harder into tech" })
    ).toBe("risk");
  });

  it("risk SUBJECTS force 'risk' regardless of value", () => {
    for (const subject of ["max_position", "risk_tolerance", "leverage", "stop_loss", "take_profit", "scoringWeight:value", "strategyAuthority", "max_daily_notional", "sector cap"]) {
      expect(classifyRiskTier({ kind: "fact", subject, value: "anything" })).toBe("risk");
    }
  });

  it("numeric size/percent values classify as 'risk'", () => {
    expect(classifyRiskTier({ kind: "fact", subject: "note", value: "put 25% into semis" })).toBe("risk");
    expect(classifyRiskTier({ kind: "fact", subject: "note", value: "buy 500 shares" })).toBe("risk");
  });

  it("intent keywords (more aggressive / increase / cap) force 'risk'", () => {
    expect(classifyRiskTier({ kind: "fact", subject: "x", value: "be more aggressive on growth" })).toBe("risk");
    expect(classifyRiskTier({ kind: "fact", subject: "x", value: "increase exposure to energy" })).toBe("risk");
  });
});

// ── PHASE 3: the store (fact written, risk dropped, chat hard-capped) ───────────
describe("PHASE 3 — ingestLearned writes facts, drops risk", () => {
  it("a fact-tier candidate is written as a private row", () => {
    const r = ingestLearned("p3-user", { kind: "decision", subject: "fact:TSM", value: "TSMC is the largest foundry." }, "ingest");
    expect(r.written).not.toBeNull();
    expect(r.tier).toBe("fact");
    expect(r.written?.scope).toBe("private");
    expect(listLearnedContext("p3-user").some((row) => row.subject === "fact:TSM")).toBe(true);
  });

  it("a risk-tier candidate is dropped and NOT written", () => {
    const r = ingestLearned("p3-user", { kind: "pattern", subject: "max_position", value: "raise to 30%" }, "autonomous");
    expect(r.written).toBeNull();
    expect(r.dropped).toBe("risk_dropped");
    expect(listLearnedContext("p3-user").some((row) => row.subject === "max_position")).toBe(false);
  });

  it("a chat-origin risk candidate is hard-capped: dropped and audited, never written", () => {
    const r = ingestLearned("p3-user", { kind: "pattern", subject: "growth", value: "lean much harder into growth", intent: "lean much harder into growth" }, "chat");
    expect(r.written).toBeNull();
    expect(r.dropped).toBe("chat_risk_dropped");
    expect(listLearnedContext("p3-user").some((row) => row.value.includes("lean much harder"))).toBe(false);
    expect(listAudit(50, "p3-user").some((a) => a.kind === "learned_context.drop")).toBe(true);
  });

  it("PII is dropped even when it would otherwise be a fact", () => {
    const r = ingestLearned("p3-user", { kind: "fact", subject: "note", value: "my SSN is 123-45-6789" }, "ingest");
    expect(r.written).toBeNull();
    expect(r.dropped).toBe("pii");
  });

  it("only fact-tier rows are returned for a decision", () => {
    // Directly insert a risk-tier row (bypassing ingest) and confirm retrieval excludes it.
    insertLearnedContext(makeRow({ userId: "p3-user", contributorUserId: "p3-user", subject: "risk-row", value: "x", riskTier: "risk", symbol: "AMD" }));
    const facts = listLearnedContextForDecision("p3-user", ["AMD"]);
    expect(facts.every((row) => row.riskTier === "fact")).toBe(true);
  });
});

// ── PHASE 4: chat producer routes pattern/decision FACTS to learned_context ──────
describe("PHASE 4 — extractLearnedCandidates lights up dormant pattern/decision kinds", () => {
  it("a durable structural fact extracts as a decision candidate", () => {
    const cands = extractLearnedCandidates("ASML is the sole supplier of EUV machines.");
    expect(cands.some((c) => c.kind === "decision")).toBe(true);
  });

  it("a recurring behavioral observation extracts as a pattern candidate", () => {
    const cands = extractLearnedCandidates("NVDA usually drifts higher for days after earnings.");
    expect(cands.some((c) => c.kind === "pattern")).toBe(true);
  });

  it("a chat fact lands in learned_context; a risk-adjacent phrase lands nowhere", () => {
    // Fact path
    for (const c of extractLearnedCandidates("ASML is the sole supplier of EUV machines.")) {
      ingestLearned("p4-user", c, "chat");
    }
    expect(listLearnedContext("p4-user").length).toBeGreaterThan(0);

    // Risk-adjacent path: classifier drops it, nothing written.
    const before = listLearnedContext("p4-user").length;
    ingestLearned("p4-user", { kind: "pattern", subject: "tech", value: "be much more aggressive on tech", intent: "be much more aggressive on tech" }, "chat");
    expect(listLearnedContext("p4-user").length).toBe(before);
  });
});

// ── retrieval relevance ─────────────────────────────────────────────────────────
describe("retrieveLearnedContext relevance", () => {
  it("returns symbol-matched and symbol-less facts, formatted as advisory bullets", () => {
    ingestLearned("p5-user", { kind: "decision", subject: "fact:META", value: "META owns Instagram and WhatsApp.", symbol: "META" }, "ingest");
    ingestLearned("p5-user", { kind: "decision", subject: "fact:general", value: "Rate cuts broadly help growth stocks." }, "ingest");
    const out = retrieveLearnedContext("p5-user", ["META"]);
    expect(out.some((s) => s.includes("META"))).toBe(true);
    expect(out.some((s) => s.includes("Rate cuts"))).toBe(true);
    // A fact for an unrelated symbol must not appear.
    ingestLearned("p5-user", { kind: "decision", subject: "fact:XOM", value: "XOM is an oil major.", symbol: "XOM" }, "ingest");
    expect(retrieveLearnedContext("p5-user", ["META"]).some((s) => s.includes("XOM"))).toBe(false);
  });
});
