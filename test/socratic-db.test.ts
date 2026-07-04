import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-socratic-${randomUUID()}.db`)}`;
  // Keyword layer is authoritative + deterministic for these tests (no LLM semantic-gate call).
  process.env.LEARNED_CONTEXT_SEMANTIC_GATE = "off";
});

// Captures every storeContexts call so we can assert the re-index after a coach-note append
// carries the note in its embedded text, without needing real Pinecone/Voyage credentials.
const storeContextsCalls: Array<{ documents: Array<{ text: string; metadata?: Record<string, unknown> }>; options?: { dedupKeyPrefix?: string } }> = [];
vi.mock("../src/lib/vector-db", () => ({
  storeContexts: async (
    documents: Array<{ text: string; metadata?: Record<string, unknown> }>,
    _userId?: string,
    options?: { dedupKeyPrefix?: string }
  ) => {
    storeContextsCalls.push({ documents, options });
    return { attempted: documents.length, indexed: documents.length };
  }
}));

describe("Socratic decision persistence", () => {
  it("persists decision cases, coach notes, and framework proposal status", async () => {
    const {
      appendSocraticDecisionCoachNote,
      createSocraticFrameworkProposal,
      listSocraticDecisionCases,
      listSocraticFrameworkProposals,
      updateSocraticFrameworkProposalStatus,
      upsertSocraticDecisionCase
    } = await import("../src/lib/db");

    const decisionId = upsertSocraticDecisionCase({
      userId: "u1",
      connectedAccountId: "acct-1",
      runId: "run-1",
      proposalId: "prop-1",
      accountNumber: "acct",
      symbol: "AAPL",
      side: "buy",
      status: "proposed",
      authority: "decide",
      thesis: "Mean-Reversion",
      rationale: "Forced selling looks temporary.",
      action: "BUY AAPL $1000",
      evidence: [{ kind: "policy", title: "Approved", summary: "Preference override applied.", tone: "positive" }],
      ragAttributions: [],
      dissent: []
    });

    expect(decisionId).toBe("prop-1");
    expect(listSocraticDecisionCases("u1", { connectedAccountId: "acct-1" })[0]?.symbol).toBe("AAPL");

    const coached = await appendSocraticDecisionCoachNote(decisionId, "Favor broader crash baskets next time.", "u1");
    expect(coached?.coachNotes).toEqual(["Favor broader crash baskets next time."]);

    // Re-indexing is fire-and-forget (a dynamic import + .then()/.catch()), so poll until the mocked
    // storeContexts call lands rather than assuming a fixed number of microtask flushes. A coach note
    // now lands in TWO places: the re-indexed decision doc (dedupKeyPrefix "socratic-decision") and
    // its own standalone coach-note vector (dedupKeyPrefix "coach-note") — filter by prefix, not just
    // text, since both docs' text includes the note.
    await vi.waitFor(() => {
      const hasCoachCall = storeContextsCalls.some(
        (call) =>
          call.options?.dedupKeyPrefix === "socratic-decision" &&
          call.documents.some((doc) => doc.text.includes("Favor broader crash baskets next time."))
      );
      expect(hasCoachCall).toBe(true);
    });

    // The re-indexed vector-memory doc's TEXT contains the coach note (not frozen at "coach_notes:
    // none" the way it was written at creation) — same contextId/dedupKeyPrefix, so this is an
    // in-place upsert, not a duplicate vector.
    const coachCalls = storeContextsCalls.filter(
      (call) =>
        call.options?.dedupKeyPrefix === "socratic-decision" &&
        call.documents.some((doc) => doc.text.includes("Favor broader crash baskets next time."))
    );
    expect(coachCalls.length).toBeGreaterThanOrEqual(1);
    expect(coachCalls[coachCalls.length - 1].options?.dedupKeyPrefix).toBe("socratic-decision");

    // The same coach note also landed as its own standalone 'coach-note' vector (item 2: coach-note
    // vectors), proving the re-index and the standalone note-vector both fire on every append.
    const coachNoteVectorCall = storeContextsCalls.find(
      (call) =>
        call.options?.dedupKeyPrefix === "coach-note" &&
        call.documents.some((doc) => doc.text === "Favor broader crash baskets next time.")
    );
    expect(coachNoteVectorCall).toBeDefined();

    const frameworkId = createSocraticFrameworkProposal({
      userId: "u1",
      connectedAccountId: "acct-1",
      decisionId,
      runId: "run-1",
      subsystem: "sizing",
      priority: "high",
      title: "Raise panic-basket sizing",
      rationale: "Override succeeded in a liquidity crash.",
      proposedChange: "When breadth panic reverses, allow larger basket deployment.",
      evidence: []
    });

    expect(listSocraticFrameworkProposals("u1", { connectedAccountId: "acct-1" })[0]?.id).toBe(frameworkId);
    const updated = updateSocraticFrameworkProposalStatus(frameworkId, "accepted", "u1", "Use this in next flash-crash run.");
    expect(updated?.status).toBe("accepted");
    expect(updated?.ownerResponse).toContain("flash-crash");
  });
});

// ── Coaching becomes durable learning ────────────────────────────────────────────
describe("Coaching becomes durable learning (ingestLearned + archival)", () => {
  function seedDecision(userId: string, overrides: Partial<Parameters<typeof import("../src/lib/db")["upsertSocraticDecisionCase"]>[0]> = {}) {
    return import("../src/lib/db").then(({ upsertSocraticDecisionCase }) =>
      upsertSocraticDecisionCase({
        userId,
        symbol: "NVDA",
        status: "proposed",
        authority: "decide",
        thesis: "Breakout",
        rationale: "Momentum continuation.",
        action: "BUY NVDA $1000",
        evidence: [],
        ragAttributions: [],
        dissent: [],
        ...overrides
      })
    );
  }

  it("a fact-tier coach note lands a durable learned_context row linked to the decision id", async () => {
    const { appendSocraticDecisionCoachNote, listLearnedContext, getSocraticDecisionCase } = await import("../src/lib/db");
    const decisionId = await seedDecision("coach-fact-user");

    const updated = await appendSocraticDecisionCoachNote(decisionId, "NVDA is the dominant AI-accelerator supplier.", "coach-fact-user");
    expect(updated).toBeDefined();

    const facts = listLearnedContext("coach-fact-user");
    const linked = facts.find((row) => row.subject === `coach:${decisionId}`);
    expect(linked).toBeDefined();
    expect(linked?.origin).toBe("coach");
    expect(linked?.riskTier).toBe("fact");
    expect(linked?.value).toContain("dominant AI-accelerator supplier");

    // The decision case's evidence carries "coached" + promoted-to-durable-lesson provenance.
    const decision = getSocraticDecisionCase(decisionId, "coach-fact-user");
    const coachEvidence = decision?.evidence.find((e) => e.kind === "coaching");
    expect(coachEvidence?.title).toContain("promoted to durable lesson");
    expect(coachEvidence?.source).toBe(`learned_context:${linked?.id}`);
  });

  it("a risk-tier coach note routes to the learned-context approval inbox, not the brain", async () => {
    const { appendSocraticDecisionCoachNote, listLearnedContext, listPendingLearnedContext, getSocraticDecisionCase } = await import(
      "../src/lib/db"
    );
    const decisionId = await seedDecision("coach-risk-user");

    await appendSocraticDecisionCoachNote(decisionId, "Raise max position sizing to 30% next time.", "coach-risk-user");

    // Never written to the brain.
    expect(listLearnedContext("coach-risk-user").some((row) => row.subject === `coach:${decisionId}`)).toBe(false);
    // Queued for human confirmation instead.
    const pending = listPendingLearnedContext("coach-risk-user", "pending");
    const queued = pending.find((row) => row.subject === `coach:${decisionId}`);
    expect(queued).toBeDefined();
    expect(queued?.origin).toBe("coach");
    expect(queued?.riskTier).toBe("risk");

    const decision = getSocraticDecisionCase(decisionId, "coach-risk-user");
    const coachEvidence = decision?.evidence.find((e) => e.kind === "coaching");
    expect(coachEvidence?.title).toContain("owner-approval inbox");
  });

  it("archives coach notes once the live cap is exceeded, with a receipt, and never deletes them", async () => {
    const { appendSocraticDecisionCoachNote, listArchivedCoachNotes, listAudit, getSocraticDecisionCase } = await import("../src/lib/db");
    const decisionId = await seedDecision("coach-cap-user");

    // 20 notes fill the live cap exactly; none should be archived yet.
    for (let i = 0; i < 20; i++) {
      await appendSocraticDecisionCoachNote(decisionId, `Fact-tier note number ${i}.`, "coach-cap-user");
    }
    let decision = getSocraticDecisionCase(decisionId, "coach-cap-user");
    expect(decision?.coachNotes.length).toBe(20);
    expect(listArchivedCoachNotes(decisionId, "coach-cap-user").length).toBe(0);

    // The 21st note pushes the oldest ("Fact-tier note number 0.") off the live window.
    await appendSocraticDecisionCoachNote(decisionId, "Fact-tier note number 20.", "coach-cap-user");
    decision = getSocraticDecisionCase(decisionId, "coach-cap-user");
    expect(decision?.coachNotes.length).toBe(20);
    expect(decision?.coachNotes).not.toContain("Fact-tier note number 0.");
    expect(decision?.coachNotes).toContain("Fact-tier note number 20.");

    const archived = listArchivedCoachNotes(decisionId, "coach-cap-user");
    expect(archived.length).toBe(1);
    expect(archived[0]?.note).toBe("Fact-tier note number 0.");
    expect(archived[0]?.decisionId).toBe(decisionId);

    // A receipt was emitted exactly when archival occurred (never silent).
    const receipts = listAudit(200, "coach-cap-user").filter((a) => a.kind === "socratic_decision_coach_notes_archived");
    expect(receipts.length).toBe(1);
    expect((receipts[0]?.payload as { archivedCount: number }).archivedCount).toBe(1);
  });

  it("stores each coach note as its own retrievable coach-note vector with the documented metadata shape", async () => {
    const { appendSocraticDecisionCoachNote } = await import("../src/lib/db");
    const decisionId = await seedDecision("coach-vector-user", { thesisTag: "Breakout", regime: "Risk-On" });

    storeContextsCalls.length = 0;
    await appendSocraticDecisionCoachNote(decisionId, "Watch for a fade on high-conviction breakouts.", "coach-vector-user");

    await vi.waitFor(() => {
      const hasCoachNoteDoc = storeContextsCalls.some((call) => call.options?.dedupKeyPrefix === "coach-note");
      expect(hasCoachNoteDoc).toBe(true);
    });

    const coachNoteCall = storeContextsCalls.find((call) => call.options?.dedupKeyPrefix === "coach-note");
    const doc = coachNoteCall?.documents[0];
    expect(doc?.text).toBe("Watch for a fade on high-conviction breakouts.");
    expect(doc?.metadata).toMatchObject({
      symbol: "NVDA",
      doc_type: "coach-note",
      decision_id: decisionId,
      thesis_tag: "Breakout",
      regime: "Risk-On"
    });
  });
});
