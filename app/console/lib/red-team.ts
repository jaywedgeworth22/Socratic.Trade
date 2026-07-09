/** Shared client-side helpers for rendering the Red Team (adversarial review) verdict —
 *  including the FAILURE states that were previously persisted but never shown. Label text
 *  reuses describeRedTeamFailureKind (src/lib/red-team-routing.ts, a pure leaf module) so the
 *  chip wording matches the "(provider error)"-style suffixes already stamped into proposal
 *  rationales by the policy-aware routing path. Pure module: safe for console AND mobile. */

import { describeRedTeamFailureKind } from "@/lib/red-team-routing";
import type { TradeProposal } from "@/lib/types";

export type RedTeamVerdict = NonNullable<TradeProposal["redTeamVerdict"]>;

export function redTeamFailureMeta(failureKind: RedTeamVerdict["failureKind"]): { label: string; title: string } {
  const label = describeRedTeamFailureKind(failureKind);
  switch (failureKind) {
    case "not_configured":
      return { label, title: "No adversarial-review model/key is configured, so no Red Team verdict exists for this decision." };
    case "timeout":
      return { label, title: "The adversarial reviewer did not answer within the time limit, so no verdict exists — the proposal was routed per policy instead of silently passing." };
    case "provider_error":
      return { label, title: "The reviewer model's provider returned an error, so no adversarial verdict exists for this decision." };
    case "rate_limited":
      return { label, title: "The reviewer model's provider rate-limited the call, so no adversarial verdict exists for this decision." };
    case "malformed_response":
      return { label, title: "The reviewer model answered, but not in the required structured format — its verdict could not be trusted or used." };
    default:
      return { label, title: "The adversarial review could not run, so no verdict exists for this decision." };
  }
}

/** The model to attribute a FAILED review to, without fabricating one: the verdict's own
 *  persisted model first; when the failure was "not configured" there IS no model — return
 *  null rather than blaming a configured/default model that never ran. */
export function redTeamFailureModel(verdict: RedTeamVerdict, configuredRedTeamModel?: string | null): string | null {
  const persisted = verdict.model?.trim();
  if (persisted) return persisted;
  if (verdict.failureKind === "not_configured") return null;
  return configuredRedTeamModel?.trim() || null;
}
