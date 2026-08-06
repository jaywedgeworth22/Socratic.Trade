// The SINGLE Red Team reviewer (docs/single-adversary-consolidation.md, owner-revised 2026-07-07).
// One adversarial LLM call per risk-adding opening, run on the FINALIZED (post-sizing) trade. It
// performs BOTH jobs the two former passes split between them: the in-flow Bear's fact-check of the
// strategist's claims against the structured candidate evidence (R7), and the standalone debate's
// risk critique — returning one discrete, down-only verdict: approve / approve-at-half / reject.
//
// Deliberately ABSENT (owner directive):
// - No RED_TEAM_LLM_PROVIDER / RED_TEAM_LLM_MODEL env override and no special-cased Anthropic
//   branch: the reviewer's provider/transport come purely from the user's explicit
//   `redTeamLlmModel` via resolveLlmEndpoint(role:"red") — a claude-* Red model gets the
//   forced-tool Messages transport through the SAME shared request builder as every other site.
// - No model default and no fallback to the Green model: an unchosen Red model resolves to "" and
//   this function fails closed (`not_configured`) so the caller routes the opening to a human.
// - No hidden model failover (R11): transient failures get a small bounded same-model retry
//   (fetchLlmWithRetry); a reviewer that still can't answer declares itself unavailable.

import { getActiveConnectedAccount, getPolicy, getStrategyPrompt } from "./db";
import { deriveExecutionState, llmExecutionMode, llmModeClarification } from "./execution-mode";
import { recordLlmUsage, extractLlmUsage, providerRequestIdFromPayload, remapOpenRouterTelemetry } from "./llm-usage";
import {
  interactiveStrategyReasoningEffort,
  LLM_OUTPUT_TOKEN_CAPS,
  LLM_REQUEST_DEFAULTS,
  fetchLlmWithRetry,
  resolveReviewerReasoningEffort,
  isRetryableLlmStatus,
  isRetryableLlmError
} from "./llm-request";
import { resolveLlmEndpoint } from "./llm-provider";
import { buildLlmRequestBody, llmAuthHeaders, extractLlmText, extractJsonPayload } from "./llm-call";
import { humanizeLlmError } from "./llm-errors";
import { planLlmProviderAttempts, recordLlmProviderFailure } from "./llm-provider-cooldown";
import { withLlmGeneration } from "./observability";
import { buildRedTeamReviewSystem } from "./strategy-prompts";
import { STRATEGY_PROMPT_VERSION } from "./strategy-prompt-version";
import { summarizeOpenAiRequest, summarizeOpenAiResponseText } from "./telemetry-sanitize";
import type { MarketQuoteSummary, TradeProposal, TradingPolicy } from "./types";

/** The three-way, down-only verdict set (§3.3). Anything else fails closed (§4.4). */
export type RedTeamVerdict = "approve" | "approve-at-half" | "reject";
export const RED_TEAM_VERDICTS: readonly RedTeamVerdict[] = ["approve", "approve-at-half", "reject"];

export interface RedTeamDebateResult {
  /** The reviewer's verdict — present ONLY when the review actually ran (`available: true`). */
  verdict?: RedTeamVerdict;
  /** `verdict === "reject"` — kept so existing consumers/persisted shapes keep one boolean. */
  rejected: boolean;
  /** True only when the review actually ran and returned a valid verdict (vs skipped / failed). */
  available: boolean;
  reason: string;
  /** The model that actually served (or attempted) the review — persisted onto the proposal's
   *  redTeamVerdict for accurate approval-time attribution. Absent when no endpoint was resolved. */
  model?: string;
  /**
   * Structured reason the review is unavailable (`available: false`), for policy-aware routing
   * ("RED TEAM FAILED" flag) that needs to distinguish failure modes rather than just a free-text
   * reason string. Absent when `available: true`.
   *  - `not_configured`: no Red model chosen, or no key/credential resolved for its provider.
   *  - `provider_error`: the provider returned a non-2xx response (excluding 429) after retries.
   *  - `rate_limited`: the provider returned HTTP 429 (after the bounded retry).
   *  - `timeout`: the request was aborted by the review's own timeout (or the error otherwise
   *    looks like an abort), as opposed to some other transport failure.
   *  - `malformed_response`: the provider returned a 2xx response but the body was not parseable
   *    JSON (even after fence-stripping), or was parseable JSON outside the three-verdict shape.
   */
  failureKind?: "not_configured" | "timeout" | "provider_error" | "rate_limited" | "malformed_response";
}

/**
 * Evidence context threaded from proposeTrades (R7): everything the deleted in-flow Bear used to
 * see, minus the Bull proposal list (the reviewer sees exactly ONE finalized proposal). All fields
 * are pass-through JSON for the model — this module never interprets them.
 */
export interface RedTeamReviewContext {
  currentDate?: string;
  currentMarketRegime?: string;
  regimeSeverity?: unknown;
  macroeconomicData?: unknown;
  limits?: unknown;
  socraticAuthority?: unknown;
  portfolio?: unknown;
  positions?: unknown;
  sectorComposition?: unknown;
  thesisOutcomes?: unknown;
  regimeOutcomes?: unknown;
  comboOutcomes?: unknown;
  closestHistoricalAnalogs?: string;
  ownerCoaching?: string;
  /** Compact scan candidates for the symbols under review — the R7 fact-check substrate. */
  candidatesUnderReview?: unknown;
}

/** Finalized-size facts the prompt states upfront (§3.4) — computed by the caller, which owns the
 *  sizing pipeline; this module never re-derives them. */
export interface RedTeamFinalizedSizing {
  /** Estimated notional (USD) of the finalized order the reviewer is judging. */
  estimatedNotional?: number;
  /** Whether the finalized order is dollar-routed or quantity-routed (marketable-limit). */
  sizeBasis: "notional" | "quantity";
  /** Account NAV used by deterministic sizing. */
  portfolioValue?: number;
  /** App-computed order size as a percentage of NAV; models must not redo this arithmetic. */
  estimatedPctOfNav?: number;
  /** Canonical daily opening ceiling after resolving the user's dollar/percent mode. */
  dailyOpeningCap?: {
    mode: "pct_nav" | "dollar";
    configuredValue: number;
    effectiveNotional: number;
    pctOfNav?: number;
  };
  dailyNotionalUsed?: number;
  remainingDailyNotional?: number;
}

/** True when `error` looks like an AbortSignal.timeout()-triggered abort (vs some other thrown
 *  transport error) — used to classify RedTeamDebateResult.failureKind precisely. */
function isAbortTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.name === "TimeoutError" || /abort|timed?\s*out/i.test(error.message);
}

/**
 * Validate a parsed Red Team verdict body has the required three-way shape (§4.4). A
 * parseable-but-schema-violating response — missing verdict, non-string verdict, or ANY value
 * outside the exact three-member set (`approve_with_caution` must never read as approve) — returns
 * null and the caller fails closed (unavailable → human review), never silently approves.
 */
export function validateRedTeamVerdictShape(parsed: unknown): { verdict: RedTeamVerdict; reason: string } | null {
  if (!parsed || typeof parsed !== "object") return null;
  const candidate = parsed as { verdict?: unknown; reason?: unknown };
  if (typeof candidate.verdict !== "string") return null;
  const verdict = candidate.verdict.trim() as RedTeamVerdict;
  if (!RED_TEAM_VERDICTS.includes(verdict)) return null;
  return {
    verdict,
    reason: typeof candidate.reason === "string" && candidate.reason ? candidate.reason : "No reason provided."
  };
}

/** Abort each Red Team LLM attempt after this long so a hung provider can't wedge the run lock. */
const RED_TEAM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 45_000;

/** Verdict shape the Red Team must return — strict json_schema on OpenAI-compatible transports and
 *  the forced-tool input_schema on Anthropic (both via buildLlmRequestBody). */
export const RED_TEAM_VERDICT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "reason"],
  properties: {
    verdict: {
      enum: [...RED_TEAM_VERDICTS],
      description:
        "approve = proceed at the stated finalized size; approve-at-half = proceed at HALF the finalized size (the single allowed haircut); reject = critical flaw, do not proceed."
    },
    reason: { type: "string", description: "Your counter-argument, haircut justification, or approval reasoning." }
  }
};

/** Uniform fail-closed result helper — the review NEVER fails open (§3.7). */
function unavailable(
  reason: string,
  failureKind: NonNullable<RedTeamDebateResult["failureKind"]>,
  model?: string
): RedTeamDebateResult {
  return { rejected: false, available: false, reason, ...(model ? { model } : {}), failureKind };
}

/**
 * Run the single Red Team review on ONE finalized, risk-adding opening proposal.
 *
 * Callers guarantee (§3.5): exits (sell/cover) and net-risk-reducing buys/shorts NEVER reach this
 * function — it reviews only trades that increase |net exposure|, so a verdict can never block or
 * shrink a risk-reducing trade.
 */
export async function debateProposal(
  proposal: TradeProposal,
  quote: MarketQuoteSummary | undefined,
  userId: string = "local",
  /**
   * Optional pre-resolved policy to use INSTEAD OF re-reading `getPolicy(userId)`. The strategy
   * loop ALWAYS passes its run-scoped, account-resolved policy (R17) so account-scoped Red
   * model/reasoning choices and transient usage-budget downgrades reach the model resolution;
   * the getPolicy fallback exists for tests/ad-hoc callers only.
   */
  policyOverride?: TradingPolicy,
  /** R7 evidence context + §3.4 finalized-size facts from the strategy loop. */
  review?: { context?: RedTeamReviewContext; sizing?: RedTeamFinalizedSizing }
): Promise<RedTeamDebateResult> {
  const policy = policyOverride ?? getPolicy(userId);
  const executionState = deriveExecutionState(policy, getActiveConnectedAccount(userId));
  const basePrompt = getStrategyPrompt(userId);
  const { url, key: llmKey, model, provider, keySource, keyRef, transport } = resolveLlmEndpoint(
    policy,
    userId,
    "https://api.openai.com/v1/chat/completions",
    "red"
  );

  // NO MODEL DEFAULTS: an unchosen Red model resolves to "" — fail closed, never guess a model.
  if (!model) {
    return unavailable(
      "Red Team reviewer model is not chosen — select it under Strategy → Models.",
      "not_configured"
    );
  }
  if (!llmKey) {
    return unavailable(
      `No API key resolves for the Red Team reviewer's provider (${provider}) — add one under Connections → API keys.`,
      "not_configured",
      model
    );
  }
  if (proposal.side !== "buy" && proposal.side !== "short") {
    // Structural guard for §3.5 — exits must never be reviewable. Callers already filter; refuse
    // loudly rather than critique a risk-reducing trade.
    return unavailable(
      `Red Team review refused: ${proposal.side} is not a risk-adding opening (exits are exempt by design).`,
      "not_configured",
      model
    );
  }

  const systemPrompt = buildRedTeamReviewSystem({ side: proposal.side, symbol: proposal.symbol });
  const executionMode = llmExecutionMode(executionState) ?? "no-account";
  const userContent = JSON.stringify({
    // The FINALIZED proposal — deterministic sizing and opening enrichment already ran (§3.2).
    proposal,
    finalizedSizing: review?.sizing,
    quote,
    policy: {
      executionMode,
      executionModeClarification: llmModeClarification(executionState),
      strategyAuthority: policy.strategyAuthority,
      holdingHorizon: policy.holdingHorizon,
      maxOrderNotional: policy.maxOrderNotional,
      maxDailyNotional: policy.maxDailyNotional,
      maxDailyPctOfNav: policy.maxDailyPctOfNav,
      scoringWeights: policy.scoringWeights
    },
    ...(review?.context ?? {}),
    strategyPrompt: basePrompt
  });

  const body = buildLlmRequestBody(
    { provider, transport },
    {
      model,
      systemPrompt,
      userContent,
      // STRICT structured output everywhere it's supported (§4.2): json_schema on OpenAI/xAI/
      // Gemini/Mistral, json_object on DeepSeek (which rejects strict schemas), forced tool on
      // Anthropic — all decided inside buildLlmRequestBody from provider/transport.
      schema: { name: "red_team_verdict", schema: RED_TEAM_VERDICT_SCHEMA, description: "The Red Team's three-way verdict on the finalized trade." },
      maxOutputTokens: LLM_OUTPUT_TOKEN_CAPS.adversaryReview,
      // The reviewer's OWN per-team effort (redTeamReasoningEffort, falling back to the
      // proposer's legacy llmReasoningEffort until explicitly set — resolveReviewerReasoningEffort
      // owns that fallback). Same interactive-reasoning clamp as the Green proposal step, so a
      // stored gpt-5.5/high config can't send high reasoning on the review call and hit the
      // run-lock timeout. Under rotation the run-scoped policy already carries the rotated
      // model's recommended effort (src/lib/model-rotation.ts).
      reasoningEffort: interactiveStrategyReasoningEffort(model, resolveReviewerReasoningEffort(policy)),
      // Per-role sampling: non-zero adversary temperature so a re-run can surface a different
      // objection rather than always the identical (or absent) one. Ignored by reasoning models.
      temperature: LLM_REQUEST_DEFAULTS.adversaryTemperature,
      userId,
      keyRef,
      service: "strategy",
      feature: "red-team"
    }
  );

  const redAttempts = [
    { url, provider, model, transport, key: llmKey, keySource, keyRef, body }
  ];
  const fallbackModelList = Array.isArray(policy.redTeamFallbackModels) ? policy.redTeamFallbackModels : [];
  for (const fallbackModel of fallbackModelList.filter((m): m is string => typeof m === "string").map((m) => m.trim()).filter(Boolean)) {
    const ep = resolveLlmEndpoint({ ...policy, redTeamLlmModel: fallbackModel }, userId, "https://api.openai.com/v1/chat/completions", "red");
    if (!ep.key) continue; // No credential for this provider's model — skip it rather than fail.
    redAttempts.push({
      url: ep.url,
      provider: ep.provider,
      model: ep.model,
      transport: ep.transport,
      key: ep.key,
      keySource: ep.keySource,
      keyRef: ep.keyRef,
      body: buildLlmRequestBody(
        { provider: ep.provider, transport: ep.transport },
        {
          model: ep.model,
          systemPrompt,
          userContent,
          schema: { name: "red_team_verdict", schema: RED_TEAM_VERDICT_SCHEMA, description: "The Red Team's three-way verdict on the finalized trade." },
          maxOutputTokens: LLM_OUTPUT_TOKEN_CAPS.adversaryReview,
          reasoningEffort: interactiveStrategyReasoningEffort(ep.model, resolveReviewerReasoningEffort(policy)),
          temperature: LLM_REQUEST_DEFAULTS.adversaryTemperature,
          userId,
          keyRef: ep.keyRef,
          service: "strategy",
          feature: "red-team"
        }
      )
    });
  }

  // Cross-run cooldown planning (handoff 6b.4): rate/quota-cooled lanes are skipped (audited);
  // when EVERY lane is cooling the full chain still runs, least-recently-failed first — so the
  // fail-closed / unavailable outcomes below are decided by exactly the same code as before, the
  // cooldown only avoids pointless retries. Kill switch: LLM_PROVIDER_COOLDOWN_DISABLED=1.
  const plannedRedAttempts = planLlmProviderAttempts(redAttempts, {
    step: "red",
    userId,
    connectedAccountId: policy.connectedAccountId
  });

  const { model: canonicalModel } = remapOpenRouterTelemetry(provider, model);
  let finalModel = canonicalModel;

  try {
    const traced = await withLlmGeneration(
      {
        name: "trading.red-team.review",
        model: canonicalModel,
        userId,
        connectedAccountId: policy.connectedAccountId,
        input: summarizeOpenAiRequest(body),
        metadata: {
          endpoint: url,
          transport,
          symbol: proposal.symbol,
          side: proposal.side,
          executionMode,
          promptVersion: STRATEGY_PROMPT_VERSION
        },
        tags: ["red-team", "proposal-review"],
        output: (result) => ({
          ...summarizeOpenAiResponseText(result.text),
          verdict: result.debate.verdict ?? "unavailable",
          rejected: result.debate.rejected,
          reasonChars: result.debate.reason.length
        })
      },
      async (): Promise<{ text: string | undefined; debate: RedTeamDebateResult }> => {
        let lastError: unknown;
        for (let i = 0; i < plannedRedAttempts.length; i++) {
          const attempt = plannedRedAttempts[i];
          const isLast = i === plannedRedAttempts.length - 1;
          const next = plannedRedAttempts[i + 1];
          const { model: attemptCanonicalModel } = remapOpenRouterTelemetry(attempt.provider, attempt.model);
          finalModel = attemptCanonicalModel;

          try {
            // Fast fallback to secondary models (§4.3): 1 attempt total per provider model, fresh
            // per-attempt timeout signal so a hung provider can't wedge the per-user run lock.
            const response = await fetchLlmWithRetry(
              attempt.url,
              {
                method: "POST",
                headers: llmAuthHeaders({ provider: attempt.provider, key: attempt.key }),
                body: JSON.stringify(attempt.body)
              },
              {
                attempts: 1,
                baseDelayMs: 500,
                timeoutMs: RED_TEAM_TIMEOUT_MS,
                onRetry: (info) =>
                  console.warn(
                    `[RedTeam] transient failure (attempt ${info.attempt}${info.status ? `, HTTP ${info.status}` : ""}); retrying ${proposal.symbol} ${proposal.side} review once.`
                  )
              }
            );

            if (!response.ok) {
              // Raw body captured BEFORE humanizing: cooldown classification must see the raw
              // provider error (the humanized string says "billing" for every 429).
              const rawDetail = await response.text().catch(() => "");
              recordLlmProviderFailure({
                provider: attempt.provider,
                keySource: attempt.keySource,
                status: response.status,
                detail: rawDetail,
                model: attempt.model,
                step: "red",
                userId,
                connectedAccountId: policy.connectedAccountId
              });
              const why = humanizeLlmError(rawDetail, { provider: attempt.provider, status: response.status });
              if (!isLast && isRetryableLlmStatus(response.status)) {
                lastError = new Error(why);
                console.warn(`[RedTeam] ${attempt.model}/${attempt.provider} failed (HTTP ${response.status}); failing over to ${next.model}/${next.provider}.`);
                continue;
              }
              console.warn("Red Team LLM call failed:", why);
              const failureKind: RedTeamDebateResult["failureKind"] = response.status === 429 ? "rate_limited" : "provider_error";
              return { text: undefined, debate: unavailable(`Red Team review unavailable — ${why}`, failureKind, attempt.model) };
            }

            const payload = await response.json();
            recordLlmUsage({
              userId,
              provider: attempt.provider,
              model: attempt.model,
              context: "red-team",
              keySource: attempt.keySource,
              keyRef: attempt.keyRef,
              // Per-account usage attribution (PR #1030 coordination): the resolved run policy is
              // account-scoped, so the review's spend lands on the account it reviewed for.
              connectedAccountId: policy.connectedAccountId,
              providerRequestId: providerRequestIdFromPayload(attempt.provider, payload),
              ...extractLlmUsage(payload)
            });
            const text = extractLlmText(payload);
            finalModel = attempt.model;

            if (!text) {
              // An HTTP-200 with EMPTY content is a provider-side glitch (overloaded/deprecated
              // model), not a verdict: fail over to the next planned reviewer when one remains
              // instead of declaring the whole review unavailable. Fail-closed semantics are
              // unchanged — if the chain is exhausted the review is still unavailable.
              if (!isLast) {
                lastError = new Error("Red Team review returned no response.");
                console.warn(`[RedTeam] ${attempt.model}/${attempt.provider} returned an empty response; failing over to ${next.model}/${next.provider}.`);
                continue;
              }
              return {
                text: undefined,
                debate: unavailable("Red Team review returned no response.", "malformed_response", attempt.model)
              };
            }

            // AMBIGUITY GUARD (Codex, PR #1696): a malformed reply carrying MORE THAN ONE verdict
            // block (e.g. `{"verdict":"approve",...} {"verdict":"reject",...}`, or a multi-element
            // array of conflicting verdicts) must never resolve to whichever block happens to be
            // extracted first. Counted on the RAW text — first-balanced-block extraction below
            // would hide the trailing block. A prose false positive (the model echoing the
            // `"verdict":` key while also emitting real JSON) fails CLOSED to unavailable, which
            // is the acceptable direction for this gate.
            // JSON permits \uXXXX escapes inside property names (`{"\u0076erdict":...}` parses
            // with key "verdict"), so decode them before counting or a second, escaped verdict
            // block slips past a literal-key regex (Codex P1, round 3). Malformed escape tails
            // are left as-is — they cannot form a parseable key anyway on this strict gate.
            const escapeNormalizedText = text.replace(/\\u([0-9a-fA-F]{4})/g, (_whole, hex: string) =>
              String.fromCharCode(Number.parseInt(hex, 16))
            );
            // Quotes OPTIONAL (same class as the Bull guard, Codex round 10): an unquoted JSON5
            // `{verdict: 'reject'}` trailing block would otherwise evade the count while the
            // first double-quoted approval parses cleanly.
            const verdictKeyOccurrences = (escapeNormalizedText.match(/(?<![\w"'])["']?verdict["']?\s*:/g) ?? []).length;
            if (verdictKeyOccurrences > 1) {
              console.warn(`Red Team response contained ${verdictKeyOccurrences} verdict blocks; treating the review as ambiguous/unavailable.`);
              // The ambiguity guard stays fail-CLOSED for THIS attempt (no verdict is guessed),
              // but a second conflicting block is one model's output quirk — a fallback reviewer
              // usually won't emit it, so fail over when the chain has another attempt. If the
              // chain is exhausted the review is unavailable exactly as before.
              if (!isLast) {
                lastError = new Error("Red Team returned multiple conflicting verdict blocks.");
                console.warn(`[RedTeam] ${attempt.model}/${attempt.provider} returned an ambiguous response; failing over to ${next.model}/${next.provider}.`);
                continue;
              }
              return {
                text,
                debate: unavailable(
                  "Red Team returned multiple conflicting verdict blocks (ambiguous response); treating the review as unavailable.",
                  "malformed_response",
                  attempt.model
                )
              };
            }

            // Fence/prose-tolerant parse (§4.1 / R9 — the gemini-3.5-flash root cause) + strict shape
            // validation (§4.4): anything that isn't exactly one of the three verdicts fails CLOSED.
            // DELIBERATELY parsed WITHOUT jsonrepair (extractJsonPayload's repair stays off): repair
            // would turn a TRUNCATED reply like `{"verdict":"approve"` into a well-formed approval,
            // converting this fail-closed gate into fail-open on a risk-adding opening (Codex P1,
            // PR #1696). A response that doesn't parse as-is is UNAVAILABLE, exactly as before.
            let parsed: unknown;
            try {
              parsed = JSON.parse(extractJsonPayload(text));
            } catch {
              const looksLikeRefusal = /^(i can'?t|i cannot|i'?m not able|i am not able|as an ai)/i.test(text.trim());
              // Unparseable output is model-specific garbage, not a verdict: fail over to the
              // next planned reviewer when one remains (fail-closed if the chain is exhausted).
              if (!isLast) {
                lastError = new Error("Red Team returned an unparseable response (not valid JSON).");
                console.warn(`[RedTeam] ${attempt.model}/${attempt.provider} returned an unparseable response; failing over to ${next.model}/${next.provider}.`);
                continue;
              }
              return {
                text,
                debate: unavailable(
                  looksLikeRefusal
                    ? "Red Team model refused to answer (safety-filter style response); treating the review as unavailable."
                    : "Red Team returned an unparseable response (not valid JSON); treating the review as unavailable.",
                  "malformed_response",
                  attempt.model
                )
              };
            }
            // Bare-array unwrap (#1091): DeepSeek v4 Flash and other small/fast json_object-mode
            // providers sometimes wrap a correct verdict object in an array (e.g.
            // [{verdict:"reject",reason:"…"}]). Extract the first element instead of failing the
            // whole review as malformed — the shape validation below still gates the payload.
            if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === "object" && parsed[0] !== null) {
              parsed = parsed[0];
            }
            const verdict = validateRedTeamVerdictShape(parsed);
            if (!verdict) {
              console.warn(`Red Team returned a malformed verdict; first 200 chars: ${text.slice(0, 200)}`);
              // Shape failure is this model's output problem: fail over when a fallback reviewer
              // remains; fail closed only once the whole chain has failed.
              if (!isLast) {
                lastError = new Error("Red Team returned a malformed verdict (missing/unknown 'verdict').");
                console.warn(`[RedTeam] ${attempt.model}/${attempt.provider} returned a malformed verdict; failing over to ${next.model}/${next.provider}.`);
                continue;
              }
              return {
                text,
                debate: unavailable(
                  "Red Team returned a malformed verdict (missing/unknown 'verdict'); treating the review as unavailable.",
                  "malformed_response",
                  attempt.model
                )
              };
            }
            return {
              text,
              debate: {
                verdict: verdict.verdict,
                rejected: verdict.verdict === "reject",
                available: true,
                reason: verdict.reason,
                model: attempt.model
              }
            };
          } catch (err) {
            if (!isLast && isRetryableLlmError(err)) {
              lastError = err;
              console.warn(`[RedTeam] ${attempt.model}/${attempt.provider} errored (${(err as { message?: string })?.message ?? String(err)}); failing over to ${next.model}/${next.provider}.`);
              continue;
            }
            throw err;
          }
        }
        throw lastError;
      }
    );
    return traced.debate;
  } catch (error) {
    console.error("Failed to run Red Team review:", error);
    return unavailable(
      "Red Team review errored out.",
      isAbortTimeoutError(error) ? "timeout" : "provider_error",
      finalModel
    );
  }
}
