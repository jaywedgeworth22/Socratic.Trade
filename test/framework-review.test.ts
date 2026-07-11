import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-framework-review-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENAI_API_KEY;
});

describe("framework proposals — global reads + provenance", () => {
  it("lists proposals across all accounts (and portfolio-wide) while preserving connectedAccountId", async () => {
    const { createSocraticFrameworkProposal, listSocraticFrameworkProposals } = await import("../src/lib/db");
    const user = "glob-user";
    const base = { userId: user, subsystem: "strategy" as const, rationale: "r", proposedChange: "c" };
    createSocraticFrameworkProposal({ ...base, connectedAccountId: "acct-A", title: "from A" });
    createSocraticFrameworkProposal({ ...base, connectedAccountId: "acct-B", title: "from B" });
    createSocraticFrameworkProposal({ ...base, title: "portfolio-wide" }); // no account => NULL

    // No account filter => global: all three accounts (incl. the NULL/portfolio-wide one).
    const all = listSocraticFrameworkProposals(user, { limit: 50 });
    const titles = all.map((p) => p.title).sort();
    expect(titles).toEqual(["from A", "from B", "portfolio-wide"]);
    // Provenance preserved on each row.
    expect(all.find((p) => p.title === "from A")?.connectedAccountId).toBe("acct-A");
    expect(all.find((p) => p.title === "from B")?.connectedAccountId).toBe("acct-B");
    expect(all.find((p) => p.title === "portfolio-wide")?.connectedAccountId).toBeUndefined();

    // Explicit account filter still narrows (strict equality) — used by callers that want one account.
    const onlyA = listSocraticFrameworkProposals(user, { connectedAccountId: "acct-A", limit: 50 });
    expect(onlyA.map((p) => p.title)).toEqual(["from A"]);
  });

  it("setSocraticFrameworkProposalAiReview round-trips the advisory review without changing status/verb", async () => {
    const { createSocraticFrameworkProposal, getSocraticFrameworkProposal, setSocraticFrameworkProposalAiReview } = await import("../src/lib/db");
    const user = "ai-review-user";
    const id = createSocraticFrameworkProposal({ userId: user, subsystem: "risk", title: "t", rationale: "r", proposedChange: "c" });
    setSocraticFrameworkProposalAiReview(id, user, {
      verdict: "rewrite",
      rationale: "Scope it to crash regimes only.",
      rewrittenChange: "In a crash regime, widen the basket.",
      model: "test-model",
      reviewedAt: "2026-07-07T00:00:00.000Z"
    });
    const back = getSocraticFrameworkProposal(id, user);
    expect(back?.status).toBe("pending"); // unchanged
    expect(back?.ownerVerb).toBeUndefined(); // unchanged
    expect(back?.aiReview).toMatchObject({ verdict: "rewrite", rewrittenChange: "In a crash regime, widen the basket.", model: "test-model" });
  });
});

describe("reviewPendingFrameworkProposals — batched single-call reviewer", () => {
  it("attaches one advisory recommendation per pending proposal in a single LLM call, ignoring unknown ids", async () => {
    const { createSocraticFrameworkProposal, getSocraticFrameworkProposal, setPolicy } = await import("../src/lib/db");
    const { reviewPendingFrameworkProposals } = await import("../src/lib/framework-review");
    const user = "batch-user";

    process.env.OPENAI_API_KEY = "test-key";
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "REVIEW", llmModel: "gpt-4.1", redTeamLlmModel: "gpt-4.1-mini", scoringWeights: { ...DEFAULT_POLICY.scoringWeights } }, user);

    const idA = createSocraticFrameworkProposal({ userId: user, connectedAccountId: "acct-A", subsystem: "sizing", title: "A", rationale: "r", proposedChange: "raise size" });
    const idB = createSocraticFrameworkProposal({ userId: user, connectedAccountId: "acct-B", subsystem: "risk", title: "B", rationale: "r", proposedChange: "tighten stop" });

    let requestCount = 0;
    let requestedModel: string | undefined;
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      requestCount += 1;
      requestedModel = JSON.parse(String(init?.body ?? "{}")).model;
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            reviews: [
              { id: idA, verdict: "accept", rationale: "Sound and evidence-backed." },
              { id: idB, verdict: "rewrite", rationale: "Good intent, narrow it.", rewrittenChange: "Tighten stop only in high-vol regimes." },
              { id: "hallucinated-id", verdict: "reject", rationale: "should be ignored" }
            ]
          })
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const result = await reviewPendingFrameworkProposals(user);

    // Exactly ONE LLM call for both proposals; reviewer model = red-team model (AI-Review inheritance).
    expect(requestCount).toBe(1);
    expect(requestedModel).toBe("gpt-4.1-mini");
    expect(result.reviewed).toBe(2);

    const a = getSocraticFrameworkProposal(idA, user);
    const b = getSocraticFrameworkProposal(idB, user);
    expect(a?.aiReview?.verdict).toBe("accept");
    expect(b?.aiReview?.verdict).toBe("rewrite");
    expect(b?.aiReview?.rewrittenChange).toContain("high-vol");
    // Advisory only — statuses stay pending.
    expect(a?.status).toBe("pending");
    expect(b?.status).toBe("pending");
  });

  it("fails open with a skip reason when there is no LLM key", async () => {
    const { createSocraticFrameworkProposal } = await import("../src/lib/db");
    const { reviewPendingFrameworkProposals } = await import("../src/lib/framework-review");
    const user = "nokey-user";
    delete process.env.OPENAI_API_KEY;
    createSocraticFrameworkProposal({ userId: user, subsystem: "strategy", title: "x", rationale: "r", proposedChange: "c" });
    const result = await reviewPendingFrameworkProposals(user);
    expect(result.reviewed).toBe(0);
    expect(result.skippedReason).toBe("no_llm_key");
  });
});
