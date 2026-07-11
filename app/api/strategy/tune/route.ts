import { proposeStrategyTuning } from "@/lib/strategy-tuning";
import { validateTuningInvariants } from "@/lib/tuning-invariants";
import { getPolicy } from "@/lib/db";
import { ALL_LLM_REASONING_EFFORTS } from "@/lib/llm-request";
import type { LlmReasoningEffort } from "@/lib/types";
import { resolveRequestUserId } from "@/lib/request-user";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const tuningInFlightHost = globalThis as unknown as { __strategyTuningInFlight?: Set<string> };
const tuningInFlight: Set<string> =
  tuningInFlightHost.__strategyTuningInFlight ??
  (tuningInFlightHost.__strategyTuningInFlight = new Set<string>());

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const model = typeof body?.model === "string" && body.model.trim() ? body.model.trim() : undefined;
    const reasoningEffort: LlmReasoningEffort | undefined =
      ALL_LLM_REASONING_EFFORTS.includes(body?.reasoningEffort) ? body.reasoningEffort : undefined;
    const userId = resolveRequestUserId(request);
    const limited = enforceRateLimit(userId, "strategy/tune", RATE_LIMITS.strategyTuning);
    if (limited) return limited;
    if (tuningInFlight.has(userId)) {
      return NextResponse.json(
        { error: "strategy_tuning_in_progress", message: "A strategy tuning review is already in progress." },
        { status: 409 }
      );
    }
    tuningInFlight.add(userId);
    try {
      const proposal = await proposeStrategyTuning(userId, model, reasoningEffort);
      // P0-3: in the MANUAL path, tuning-config invariant violations are surfaced as WARNINGS (never blocks) —
      // the human reviews them alongside the proposal. (The AUTONOMOUS path fails closed on the same set.)
      // The dashboard renders `proposal.cautions`, so APPEND the warnings there (with a clear prefix) so manual
      // users actually SEE them; also keep the structured `tuningConfigWarnings` field for programmatic callers.
      const invariants = validateTuningInvariants(getPolicy(userId).tuning);
      if (invariants.ok) {
        return NextResponse.json(proposal);
      }
      const warningCautions = invariants.violations.map((v) => `Tuning-config warning: ${v.message}`);
      return NextResponse.json({
        ...proposal,
        cautions: [...(proposal.cautions ?? []), ...warningCautions],
        tuningConfigWarnings: invariants.violations
      });
    } finally {
      tuningInFlight.delete(userId);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Strategy tuning failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
