/** Pure helpers behind the Strategy page's shared "Reasoning / Thinking Effort" control —
 *  extracted from app/console/strategy/page.tsx so the sentinel-aware selection logic is
 *  unit-testable without rendering the page. No React, safe to import anywhere.
 *
 *  Rotation ("__rotate__") awareness: a rotating seat maps to the UI-only synthetic
 *  ROTATION_UI_REASONING_CAPABILITY (full generic ladder) instead of being filtered out, so the
 *  effort control stays visible and editable under rotation. That is honest because the stored
 *  effort is re-clamped PER SERVED MODEL at call time (`interactiveStrategyReasoningEffort`);
 *  server paths still fail closed on the raw sentinel (`reasoningCapabilityForModel` returns
 *  undefined for it). */

import type { LlmReasoningEffort } from "@/lib/types";
import {
  isModelRotationSentinel,
  normalizeReasoningEffortForModel,
  normalizeReasoningEffortForOptions,
  reasoningCapabilityForModel,
  ROTATION_UI_REASONING_CAPABILITY,
  type LlmReasoningCapability,
  type LlmReasoningOption
} from "@/lib/llm-request";

function uniq<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

export interface ReasoningControl {
  label: string;
  hint: string;
  options: LlmReasoningOption[];
  capabilities: LlmReasoningCapability[];
}

export function reasoningControlForModels(models: string[]): ReasoningControl | null {
  const capabilities = uniq(models.map((model) => model.trim()).filter(Boolean))
    .map((model) => (isModelRotationSentinel(model) ? ROTATION_UI_REASONING_CAPABILITY : reasoningCapabilityForModel(model)))
    .filter((capability): capability is LlmReasoningCapability => Boolean(capability));
  const uniqueCapabilities = Array.from(new Map(capabilities.map((capability) => [capability.label, capability])).values());
  if (uniqueCapabilities.length === 0) return null;

  const sharedValues = uniqueCapabilities.reduce<LlmReasoningEffort[] | null>((shared, capability) => {
    const values = capability.options.map((option) => option.value);
    return shared ? shared.filter((value) => values.includes(value)) : values;
  }, null);
  if (!sharedValues || sharedValues.length === 0) return null;

  const firstOptions = uniqueCapabilities[0]?.options ?? [];
  const options = firstOptions
    .filter((option) => sharedValues.includes(option.value))
    .map((option) => {
      const providerOption = uniqueCapabilities.flatMap((capability) => capability.options).find((candidate) => candidate.value === option.value);
      return providerOption ?? option;
    });

  if (uniqueCapabilities.length === 1) {
    const capability = uniqueCapabilities[0]!;
    return { label: capability.settingLabel, hint: capability.description, options, capabilities: uniqueCapabilities };
  }

  const labels = uniqueCapabilities.map((capability) => capability.label).join(" + ");
  return {
    label: "Shared Reasoning / Thinking",
    hint: `${labels} are active. Only values supported by every selected model are shown.`,
    options,
    capabilities: uniqueCapabilities
  };
}

export function reasoningSummary(control: ReasoningControl | null): string {
  if (!control) return "These selected models do not expose a provider-specific reasoning or thinking control here.";
  const labels = control.capabilities.map((capability) => capability.label).join(" + ");
  if (control.capabilities.some((capability) => capability.provider === "rotation")) {
    return `${labels} active — the chosen effort applies to each run's served model, clamped to that model's supported range.`;
  }
  return `${labels} active.`;
}

/** Whenever a model selection changes, the previously-saved reasoning effort may no longer be a
 *  valid/offered value for the new model pairing (e.g. a provider-specific "xhigh" that the newly
 *  chosen model doesn't expose). Recompute + include a renormalized value in the SAME save so a
 *  model-only write can never leave the stored (model, effort) combo in an invalid state — mirrors
 *  what the old single "Save models" button did by bundling the recomputed effort into one PUT.
 *  Rotating seats are excluded from the renormalization inputs: when a CONCRETE seat exists the
 *  effort renormalizes against it alone, and when ALL seats rotate the patch stays empty — the
 *  stored effort is never clamped against the synthetic full ladder (each served model clamps it
 *  at call time instead). */
export function reasoningPatchFor(models: string[], effort: LlmReasoningEffort | undefined): { llmReasoningEffort?: LlmReasoningEffort } {
  const candidates = models.filter((m) => m && !isModelRotationSentinel(m));
  const control = reasoningControlForModels(candidates);
  if (!control) return {};
  const value = normalizeReasoningValueForControl(candidates, control, effort);
  return value ? { llmReasoningEffort: value } : {};
}

/** high/xhigh/max are the EXPENSIVE, slow-latency reasoning tier every opt-in provider branch in
 *  `normalizeReasoningEffortForModel` (Mistral, DeepSeek) guards behind an explicit user request. */
export const HIGH_TIER_REASONING_EFFORTS: ReadonlySet<LlmReasoningEffort> = new Set(["high", "xhigh", "max"]);

export function normalizeReasoningValueForControl(
  models: string[],
  control: ReasoningControl | null,
  effort: LlmReasoningEffort | undefined
): LlmReasoningEffort | undefined {
  if (!control) return undefined;
  if (control.capabilities.length === 1) {
    const provider = control.capabilities[0]!.provider;
    const model = models.find((candidate) => reasoningCapabilityForModel(candidate)?.provider === provider);
    return normalizeReasoningEffortForModel(model, effort) ?? normalizeReasoningEffortForOptions(control.options, effort);
  }
  // Mixed-provider pairing (e.g. Mistral Medium 3.5's {none, high} alongside an OpenAI-reasoning
  // model's {low, medium, high}): the intersected shared option set can collapse to HIGH-TIER
  // ONLY. The generic rank-distance fallback below has no notion of any provider's opt-in floor,
  // so unguarded it would map a non-explicit request (e.g. the app's "medium" default, or the
  // request left unspecified) onto "high" -- silently enabling the slow/expensive tier on a mere
  // model-selection change, defeating the exact opt-in guarantee every single-provider branch of
  // `normalizeReasoningEffortForModel` exists to give. Only let a high-tier value through here
  // when the caller's OWN requested effort was already explicitly high-tier; otherwise leave the
  // value unset (the previously-saved effort is re-normalized independently, per model, at call
  // time by `interactiveStrategyReasoningEffort`, so no request ever silently escalates).
  const sharedValue = normalizeReasoningEffortForOptions(control.options, effort);
  if (HIGH_TIER_REASONING_EFFORTS.has(sharedValue) && !HIGH_TIER_REASONING_EFFORTS.has(effort ?? "medium")) {
    return undefined;
  }
  return sharedValue;
}
