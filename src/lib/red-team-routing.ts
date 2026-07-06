import type { OrderSide } from "./types";
import type { RedTeamDebateResult } from "./red-team";

/**
 * Human-readable label for a RedTeamDebateResult.failureKind, used in rationale notes and audit
 * payloads so a reader (human approver or the outcome/audit UI) doesn't need to decode the enum.
 * Falls back to a generic label when failureKind is absent (older/legacy verdicts, or the in-flow
 * Bear's own reason string which doesn't carry a failureKind at all).
 */
export function describeRedTeamFailureKind(failureKind: RedTeamDebateResult["failureKind"]): string {
  switch (failureKind) {
    case "not_configured":
      return "not configured";
    case "timeout":
      return "timeout";
    case "provider_error":
      return "provider error";
    case "rate_limited":
      return "rate limited";
    case "malformed_response":
      return "malformed response";
    default:
      return "unavailable";
  }
}

export interface AdversaryUnavailableRouting {
  /** True when this proposal must be held for human approval (openings only). */
  holdForHuman: boolean;
  /** Loud, human-facing rationale note to append to `proposal.rationale`. */
  note: string;
}

/**
 * Policy-aware routing decision for when the approval-time Red Team debate (`debateProposal`)
 * could NOT run (`available: false`) — de-risk-only routing consistency (design doc / board item
 * "Bear/Red-Team unavailable -> policy-aware routing for ALL failure modes").
 *
 * Openings (`buy`/`short`) are risk-INCREASING: ALWAYS hold for human review, matching the in-flow
 * Bear's existing openings-only gate (strategy.ts's `bearReviewUnavailable` branch) so the two
 * adversary passes agree on failure-mode routing. This is unconditional regardless of the policy
 * flag below.
 *
 * Exits (`sell`/`cover`) are risk-REDUCING. Whether they are held for human review depends on
 * `deRiskExitsOnAdversaryUnavailable` (default false/undefined):
 *  - DEFAULT (false/undefined): hold for human review, same as openings — byte-identical to
 *    today's unconditional `requiresHumanReview.add(proposal)` in strategy.ts regardless of side.
 *  - OPT-IN (true): do NOT hold — blocking a de-risking trade on an adversary outage is itself
 *    unsafe (mirrors the rationale-collapse gate and the in-flow Bear's own "exits must still flow
 *    through" comment). Instead we append a loud rationale note and let the caller emit the parity
 *    audit event, so the human-facing signal is never silently lost even though the order proceeds
 *    without a hold.
 *
 * Side classification is RAW-side (buy/short vs sell/cover), the codebase-wide convention (see
 * strategy.ts's other `isOpening`-style checks) — net-exposure-aware classification (a buy that
 * actually covers an existing short, netting risk-reducing) is an explicitly deferred follow-up,
 * not implemented here.
 */
export function routeOnAdversaryUnavailable(
  side: OrderSide,
  failureKind: RedTeamDebateResult["failureKind"],
  reason: string,
  deRiskExitsOnAdversaryUnavailable?: boolean
): AdversaryUnavailableRouting {
  const isOpening = side === "buy" || side === "short";
  const kindLabel = describeRedTeamFailureKind(failureKind);

  if (isOpening) {
    return {
      holdForHuman: true,
      note: `\n\nRed Team review was REQUIRED (high conviction) but unavailable (${kindLabel}: ${reason}); routed to human approval.`
    };
  }

  if (deRiskExitsOnAdversaryUnavailable !== true) {
    // Default OFF: default behavior is byte-identical to main — exits hold for human review too.
    return {
      holdForHuman: true,
      note: `\n\nRed Team review was REQUIRED but unavailable (${kindLabel}: ${reason}); routed to human approval.`
    };
  }

  return {
    holdForHuman: false,
    note: `\n\n⚠ RED TEAM FAILED (${kindLabel}): review unavailable — proceeding because this order reduces risk.`
  };
}
