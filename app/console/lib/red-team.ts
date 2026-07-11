/** Shared client-side helpers for rendering the Red Team (adversarial review) verdict —
 *  including the FAILURE states that were previously persisted but never shown. Label text
 *  reuses describeRedTeamFailureKind (src/lib/red-team-routing.ts, a pure leaf module) so the
 *  chip wording matches the "(provider error)"-style suffixes already stamped into proposal
 *  rationales by the policy-aware routing path. Pure module: safe for console AND mobile. */

import { isModelRotationSentinel } from "@/lib/llm-request";
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

/** Which ONE of the three mutually-exclusive Red Team sections an approval card renders, given
 *  whether a structured verdict is present and the legacy `adversaryUnavailable` decision flag.
 *  Total by construction — exactly one state is returned — so the "review unavailable" note can
 *  never render alongside the verdict panel again. (Regression guard: a FAILED verdict used to
 *  satisfy both the verdict panel AND a separate unavailable callout, rendering the same
 *  provider-error text twice — the adversary-review-duplication bug.)
 *
 *  - "verdict-panel":      a structured verdict exists (available OR failed). The panel owns it,
 *                          including the failure state and its "sole adversary" framing.
 *  - "legacy-unavailable": no structured verdict, but the legacy flag says the review could not run
 *                          (proposals persisted before the single-adversary consolidation).
 *  - "no-review":          no verdict and no unavailable flag — the review simply never triggered. */
export type RedTeamCardState = "verdict-panel" | "legacy-unavailable" | "no-review";

export function redTeamCardState(hasVerdict: boolean, adversaryUnavailable: boolean): RedTeamCardState {
  if (hasVerdict) return "verdict-panel";
  if (adversaryUnavailable) return "legacy-unavailable";
  return "no-review";
}

/** The model to attribute a FAILED review to, without fabricating one: the verdict's own
 *  persisted model first; when the failure was "not configured" there IS no model — return
 *  null rather than blaming a configured/default model that never ran. A configured
 *  "__rotate__" sentinel is likewise never a model that ran (it is a rotation marker the run
 *  resolves to a concrete pick), so it must never be displayed as the failed reviewer. */
export function redTeamFailureModel(verdict: RedTeamVerdict, configuredRedTeamModel?: string | null): string | null {
  const persisted = verdict.model?.trim();
  if (persisted) return persisted;
  if (verdict.failureKind === "not_configured") return null;
  if (isModelRotationSentinel(configuredRedTeamModel)) return null;
  return configuredRedTeamModel?.trim() || null;
}
