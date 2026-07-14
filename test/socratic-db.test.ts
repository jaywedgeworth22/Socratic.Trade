import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-socratic-${randomUUID()}.db`)}`;
});

// Captures every storeContexts call so we can assert the re-index after a coach-note append
// carries the note in its embedded text, without needing real Pinecone/Voyage credentials.
const storeContextsCalls: Array<{ documents: Array<{ text: string }>; options?: { dedupKeyPrefix?: string; scope?: string } }> = [];
vi.mock("../src/lib/vector-db", () => ({
  storeContexts: async (documents: Array<{ text: string }>, _userId?: string, options?: { dedupKeyPrefix?: string; scope?: string }) => {
    storeContextsCalls.push({ documents, options });
    return { attempted: documents.length, indexed: documents.length };
  }
}));

describe("Socratic decision persistence", () => {
  it("persists decision cases, coach notes, and framework proposal status", async () => {
    const {
      attachSocraticDecisionCoachPrimitives,
      appendSocraticDecisionCoachNote,
      createSocraticFrameworkProposal,
      getSocraticFrameworkProposal,
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

    const coached = appendSocraticDecisionCoachNote(decisionId, "Favor broader crash baskets next time.", "u1");
    expect(coached?.coachNotes).toEqual(["Favor broader crash baskets next time."]);

    // Re-indexing is fire-and-forget (a dynamic import + .then()/.catch()), so poll until the mocked
    // storeContexts call lands rather than assuming a fixed number of microtask flushes.
    await vi.waitFor(() => {
      const hasCoachCall = storeContextsCalls.some((call) =>
        call.documents.some((doc) => doc.text.includes("Favor broader crash baskets next time."))
      );
      expect(hasCoachCall).toBe(true);
    });

    // The re-indexed vector-memory doc's TEXT contains the coach note (not frozen at "coach_notes:
    // none" the way it was written at creation) — same contextId/dedupKeyPrefix, so this is an
    // in-place upsert, not a duplicate vector.
    const coachCalls = storeContextsCalls.filter((call) =>
      call.documents.some((doc) => doc.text.includes("Favor broader crash baskets next time."))
    );
    expect(coachCalls.length).toBeGreaterThanOrEqual(1);
    expect(coachCalls[coachCalls.length - 1].options?.dedupKeyPrefix).toBe("socratic-decision");
    expect(coachCalls[coachCalls.length - 1].options?.scope).toBe("private");

    const promoted = await attachSocraticDecisionCoachPrimitives(
      decisionId,
      {
        note: "Convert this into a durable sizing lesson.",
        promoteTo: "lesson",
        lessonText: "Size panic baskets more aggressively when breadth is capitulatory."
      },
      "u1"
    );
    expect(promoted?.decision.coachNotes.at(-1)).toBe("Convert this into a durable sizing lesson.");
    expect(promoted?.decision.lessons).toContain("Size panic baskets more aggressively when breadth is capitulatory.");

    const frameworkPromotion = await attachSocraticDecisionCoachPrimitives(
      decisionId,
      {
        note: "Framework should capture this as a repeatable crash playbook.",
        promoteTo: "framework",
        framework: {
          subsystem: "strategy",
          priority: "high",
          title: "Codify the crash playbook",
          rationale: "Broader basket entries would have improved the recovery capture.",
          proposedChange: "When breadth panic reverses, deploy the broader basket instead of a single-name entry."
        }
      },
      "u1"
    );
    expect(frameworkPromotion?.frameworkProposal?.title).toBe("Codify the crash playbook");
    expect(getSocraticFrameworkProposal(frameworkPromotion?.frameworkProposal?.id ?? "", "u1")?.decisionId).toBe(decisionId);

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
    const updated = updateSocraticFrameworkProposalStatus(frameworkId, "accepted", "u1", "Use this in next flash-crash run.", "rewrite");
    expect(updated?.status).toBe("accepted");
    expect(updated?.ownerVerb).toBe("rewrite");
    expect(updated?.ownerResponse).toContain("flash-crash");
  });

  it("serves one decision case by id through the read-only route", async () => {
    const { finishStrategyRun, insertStrategyRun, upsertSocraticDecisionCase } = await import("../src/lib/db");
    const { GET } = await import("../app/api/socratic/decisions/[id]/route");

    insertStrategyRun("trace-run-1");
    finishStrategyRun("trace-run-1", "completed", "Completed a trace-worthy run.");

    const decisionId = upsertSocraticDecisionCase({
      runId: "trace-run-1",
      status: "observed",
      authority: "propose",
      thesis: "Portfolio posture",
      rationale: "No single-name action was warranted.",
      action: "Observe",
      evidence: [],
      ragAttributions: [],
      dissent: []
    });

    const response = await GET(new Request(`http://localhost/api/socratic/decisions/${decisionId}`), {
      params: Promise.resolve({ id: decisionId })
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      decision: { id: decisionId, thesis: "Portfolio posture", runId: "trace-run-1" },
      run: { id: "trace-run-1", status: "completed", summary: "Completed a trace-worthy run." }
    });

    const missing = await GET(new Request("http://localhost/api/socratic/decisions/missing"), {
      params: Promise.resolve({ id: "missing" })
    });
    expect(missing.status).toBe(404);
  });

  it("promotes coach notes and validates framework rewrite semantics through the API routes", async () => {
    const { createSocraticFrameworkProposal, upsertSocraticDecisionCase } = await import("../src/lib/db");
    const { POST } = await import("../app/api/socratic/decisions/[id]/coach/route");
    const { PATCH } = await import("../app/api/socratic/framework/[id]/route");

    const decisionId = upsertSocraticDecisionCase({
      connectedAccountId: "acct-2",
      status: "blocked",
      authority: "decide",
      thesis: "Crash basket",
      rationale: "Need a repeatable coaching primitive.",
      action: "Wait",
      evidence: [],
      ragAttributions: [],
      dissent: []
    });

    const coachResponse = await POST(
      new Request(`http://localhost/api/socratic/decisions/${decisionId}/coach`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          note: "Promote this into a framework primitive.",
          promoteTo: "framework",
          framework: {
            subsystem: "coaching",
            priority: "high",
            title: "Capture the crash coaching rule",
            rationale: "This should become a reusable review rule.",
            proposedChange: "When a crash basket is blocked, emit the lesson into framework review."
          }
        })
      }),
      { params: Promise.resolve({ id: decisionId }) }
    );
    expect(coachResponse.status).toBe(200);
    await expect(coachResponse.json()).resolves.toMatchObject({
      decision: { id: decisionId },
      frameworkProposal: { decisionId, title: "Capture the crash coaching rule", subsystem: "coaching" }
    });

    const frameworkId = createSocraticFrameworkProposal({
      connectedAccountId: "acct-2",
      decisionId,
      subsystem: "risk",
      title: "Tighten crash veto handling",
      rationale: "Need explicit rewrite semantics.",
      proposedChange: "Require a narrow rewrite verb path."
    });

    const missingRewriteText = await PATCH(
      new Request(`http://localhost/api/socratic/framework/${frameworkId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "accepted", ownerVerb: "rewrite" })
      }),
      { params: Promise.resolve({ id: frameworkId }) }
    );
    expect(missingRewriteText.status).toBe(400);

    const validRewrite = await PATCH(
      new Request(`http://localhost/api/socratic/framework/${frameworkId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "accepted",
          ownerVerb: "rewrite",
          ownerResponse: "Split this into a crash-only guardrail and a lesson-review path."
        })
      }),
      { params: Promise.resolve({ id: frameworkId }) }
    );
    expect(validRewrite.status).toBe(200);
    await expect(validRewrite.json()).resolves.toMatchObject({
      id: frameworkId,
      status: "accepted",
      ownerVerb: "rewrite",
      ownerResponse: "Split this into a crash-only guardrail and a lesson-review path."
    });
  });

  it("writeSocraticDecisionOutcome re-merges at write time so a concurrently-written worker row survives a stale caller (Finding 1 regression)", async () => {
    const { upsertSocraticDecisionCase, writeSocraticDecisionOutcome, getSocraticDecisionCase } = await import("../src/lib/db");

    const decisionId = upsertSocraticDecisionCase({
      userId: "u-lost-update",
      runId: "run-lu-1",
      proposalId: "prop-lu-1",
      accountNumber: "acct",
      symbol: "AAPL",
      side: "buy",
      status: "placed",
      authority: "decide",
      thesis: "Momentum",
      rationale: "Breakout with volume.",
      action: "BUY AAPL $1000",
      evidence: [],
      ragAttributions: [],
      dissent: []
    });

    // Simulate the durable due-jobs WORKER (drainDueIntradaySampleJobs) resolving the 15m horizon
    // mid-pass, persisted directly through the same writer a real worker uses.
    await writeSocraticDecisionOutcome(
      decisionId,
      {
        status: "open",
        measuredAt: "2026-07-05T12:15:00.000Z",
        outcomes: [
          { horizon: "15m", returnPct: 3, maturedAt: "2026-07-05T12:15:00.000Z", priceBasis: "fill->live_quote(+15m)", resolution: "ok" }
        ]
      },
      "u-lost-update"
    );
    const afterWorker = getSocraticDecisionCase(decisionId, "u-lost-update");
    expect(afterWorker?.outcome?.outcomes.find((r) => r.horizon === "15m")?.resolution).toBe("ok");

    // Now the INLINE maturation pass writes back a STALE outcomes array built from a pass-start
    // snapshot taken BEFORE the worker's write above (measureCase holds `outcomes` across awaits) —
    // it has no 15m row at all, only a later-horizon row the inline pass itself just measured.
    const staleOutcomes = [
      { horizon: "1h" as const, maturedAt: "2026-07-05T13:00:00.000Z", priceBasis: "fill->live_quote", resolution: "unresolvable" as const, reason: "no_intraday_source" }
    ];
    await writeSocraticDecisionOutcome(decisionId, { status: "open", measuredAt: "2026-07-05T13:00:00.000Z", outcomes: staleOutcomes }, "u-lost-update");

    // The worker-written 15m row must SURVIVE the stale write — this is the lost-update bug: without
    // the write-time re-merge, the stale array (missing 15m entirely) would have wholesale-replaced
    // the persisted outcome and erased it.
    const final = getSocraticDecisionCase(decisionId, "u-lost-update");
    const row15m = final?.outcome?.outcomes.find((r) => r.horizon === "15m");
    expect(row15m?.resolution).toBe("ok");
    expect(row15m?.returnPct).toBe(3);
    // And the inline pass's own new row is still present alongside it (a real merge, not a partial
    // overwrite that drops the caller's own contribution).
    const row1h = final?.outcome?.outcomes.find((r) => r.horizon === "1h");
    expect(row1h?.resolution).toBe("unresolvable");
  });
});
