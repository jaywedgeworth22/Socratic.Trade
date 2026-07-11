/** Batched, single-LLM-call reviewer for pending Socratic framework ("learning")
 *  proposals. It reads ALL pending proposals across the user's accounts, sends them to
 *  the reviewer model in ONE request, and attaches a per-proposal ADVISORY recommendation
 *  (verdict + rationale + optional rewrite) via `setSocraticFrameworkProposalAiReview`.
 *
 *  It never changes a proposal's status or owner verb — the owner still makes the final
 *  accept/reject/rewrite call; this only adds an AI opinion next to each one. The single
 *  call trades a little per-item isolation for a large efficiency win (N proposals → 1
 *  request); demux back to proposal ids is by explicit id in the model's array output. */

import { audit, getPolicy, listSocraticFrameworkProposals, setSocraticFrameworkProposalAiReview } from "./db";
import { isOverLlmBudget } from "./llm-budget";
import { buildLlmRequestBody, extractLlmText, llmAuthHeaders } from "./llm-call";
import { humanizeLlmError } from "./llm-errors";
import { resolveLlmEndpoint } from "./llm-provider";
import { LLM_OUTPUT_TOKEN_CAPS, llmFetch } from "./llm-request";
import { extractLlmUsage, recordLlmUsage } from "./llm-usage";
import { withLlmGeneration } from "./observability";
import { summarizeOpenAiRequest, summarizeOpenAiResponseText } from "./telemetry-sanitize";
import type { SocraticFrameworkAiReview, SocraticFrameworkOwnerVerb, TradingPolicy } from "./types";

const REVIEW_SYSTEM_PROMPT = `You are the batched Framework-Proposal Reviewer for Socratic Trade, an autonomous equity-reasoning desk.
You receive a JSON list of PENDING "framework" proposals — small, reviewable improvements to the strategy/risk/sizing/universe/evidence/coaching subsystems, each extracted from a real closed decision. Some come from different connected accounts (see fromAccount); treat them together as one owner's learning.
For EACH proposal, recommend one verdict for the owner:
- "accept": the change is sound and worth applying as written.
- "rewrite": the intent is good but the wording/scope should change — provide an improved "rewrittenChange".
- "reject": the change is unsound, redundant, overfit to one decision, or contradicts a better existing rule.
Be conservative: prefer "reject" or "rewrite" over "accept" when evidence is thin or the change is a numeric position-size/percent prescription (direction words only). You are advisory — the owner still decides.
Respond with STRICT JSON only (no markdown, no prose outside the JSON), one entry per input id:
{"reviews":[{"id":"<proposal id>","verdict":"accept|rewrite|reject","rationale":"<one concise sentence>","rewrittenChange":"<present ONLY for rewrite: the improved change>"}]}`;

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Resolve the reviewer model the same way the strategy "AI Review" does: the Red Team
 *  model first, then the primary/Green model (both account-scoped policy fields). */
function reviewerPolicy(policy: TradingPolicy): TradingPolicy {
  const reviewModel = policy.redTeamLlmModel?.trim() || policy.llmModel?.trim();
  return reviewModel ? { ...policy, llmModel: reviewModel } : policy;
}

interface ParsedReview {
  id: string;
  verdict: SocraticFrameworkOwnerVerb;
  rationale: string;
  rewrittenChange?: string;
}

function parseReviewResponse(text: string): ParsedReview[] | undefined {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  let obj: unknown;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    return undefined;
  }
  const reviews = (obj as { reviews?: unknown })?.reviews;
  if (!Array.isArray(reviews)) return undefined;
  const out: ParsedReview[] = [];
  for (const r of reviews) {
    const row = r as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id : undefined;
    const verdict = row.verdict;
    const rationale = typeof row.rationale === "string" ? row.rationale.trim() : "";
    if (!id || (verdict !== "accept" && verdict !== "reject" && verdict !== "rewrite") || !rationale) continue;
    const rewrittenChange = verdict === "rewrite" && typeof row.rewrittenChange === "string" && row.rewrittenChange.trim()
      ? row.rewrittenChange.trim()
      : undefined;
    out.push({ id, verdict, rationale, ...(rewrittenChange ? { rewrittenChange } : {}) });
  }
  return out;
}

export interface FrameworkReviewResult {
  reviewed: number;
  skippedReason?: string;
  model?: string;
  verdicts?: Array<{ id: string; verdict: SocraticFrameworkOwnerVerb }>;
}

/** Review all pending framework proposals for `userId` (across accounts) in one LLM call
 *  and attach advisory recommendations. Fail-open: returns a skip reason instead of
 *  throwing when there is nothing to review, no key, or the budget is spent. */
export async function reviewPendingFrameworkProposals(
  userId: string = "local",
  opts: { limit?: number } = {}
): Promise<FrameworkReviewResult> {
  const limit = Math.max(1, Math.min(40, Math.floor(opts.limit ?? 25)));
  const pending = listSocraticFrameworkProposals(userId, { status: "pending", limit });
  if (pending.length === 0) return { reviewed: 0, skippedReason: "no_pending" };
  if (isOverLlmBudget(userId)) return { reviewed: 0, skippedReason: "over_budget" };

  const policy = reviewerPolicy(getPolicy(userId));
  const { url, key, model, provider, keySource, keyRef, transport } = resolveLlmEndpoint(
    policy,
    userId,
    "https://api.openai.com/v1/chat/completions"
  );
  if (!key) return { reviewed: 0, skippedReason: "no_llm_key" };

  const userContent = JSON.stringify({
    proposals: pending.map((p) => ({
      id: p.id,
      subsystem: p.subsystem,
      priority: p.priority,
      title: p.title,
      rationale: truncate(p.rationale, 600),
      proposedChange: truncate(p.proposedChange, 900),
      fromAccount: p.connectedAccountId ?? "portfolio-wide",
      evidence: p.evidence.slice(0, 4).map((e) => ({ kind: e.kind, title: e.title, summary: truncate(e.summary, 240) }))
    }))
  });

  const body = buildLlmRequestBody(
    { provider, transport },
    {
      model,
      systemPrompt: REVIEW_SYSTEM_PROMPT,
      userContent,
      maxOutputTokens: LLM_OUTPUT_TOKEN_CAPS.frameworkReview,
      reasoningEffort: policy.llmReasoningEffort
    }
  );

  const traced = await withLlmGeneration(
    {
      name: "trading.framework-review",
      model,
      userId,
      input: summarizeOpenAiRequest(body),
      metadata: { endpoint: url, transport },
      tags: ["framework-review"],
      output: (result: { text?: string }) => summarizeOpenAiResponseText(result.text)
    },
    async () => {
      const response = await llmFetch(url, {
        method: "POST",
        headers: llmAuthHeaders({ provider, key }),
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        console.warn(
          "[framework-review] LLM call failed:",
          humanizeLlmError(await response.text().catch(() => ""), { provider, status: response.status })
        );
        return { text: undefined };
      }
      const payload = await response.json();
      recordLlmUsage({ userId, provider, model, context: "framework-review", keySource, keyRef, ...extractLlmUsage(payload) });
      const text = extractLlmText(payload);
      return { text: typeof text === "string" ? text : undefined };
    }
  );

  if (!traced.text) return { reviewed: 0, skippedReason: "llm_empty", model };
  const parsed = parseReviewResponse(traced.text);
  if (!parsed || parsed.length === 0) return { reviewed: 0, skippedReason: "unparseable_llm_response", model };

  const byId = new Map(pending.map((p) => [p.id, p]));
  const reviewedAt = new Date().toISOString();
  const verdicts: Array<{ id: string; verdict: SocraticFrameworkOwnerVerb }> = [];
  for (const r of parsed) {
    if (!byId.has(r.id)) continue; // ignore hallucinated / stale ids
    const review: SocraticFrameworkAiReview = {
      verdict: r.verdict,
      rationale: r.rationale,
      ...(r.rewrittenChange ? { rewrittenChange: r.rewrittenChange } : {}),
      model,
      reviewedAt
    };
    setSocraticFrameworkProposalAiReview(r.id, userId, review);
    verdicts.push({ id: r.id, verdict: r.verdict });
  }
  audit("socratic_framework_ai_review", { model, reviewed: verdicts.length, verdicts }, userId);
  return { reviewed: verdicts.length, model, verdicts };
}
