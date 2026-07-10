/** The Strategy page's shared "Reasoning / Thinking Effort" control logic
 *  (app/console/strategy/reasoning-control.ts) — extracted pure helpers, with the
 *  rotation-sentinel awareness added for the rotation-UX fixes (2026-07-09):
 *  a rotating seat must SHOW the control (synthetic full ladder + honest per-served-model
 *  copy) instead of disappearing with a false "do not expose a reasoning control" line. */

import { describe, expect, it } from "vitest";
import { ALL_LLM_REASONING_EFFORTS, LLM_MODEL_ROTATION_SENTINEL } from "../src/lib/llm-request";
import {
  HIGH_TIER_REASONING_EFFORTS,
  normalizeReasoningValueForControl,
  reasoningControlForModels,
  reasoningPatchFor,
  reasoningSummary
} from "../app/console/strategy/reasoning-control";

const ROTATE = LLM_MODEL_ROTATION_SENTINEL;

describe("reasoningControlForModels — rotation sentinel keeps the control visible", () => {
  it("all-rotate seats get the full generic ladder (owner report: control used to vanish)", () => {
    const control = reasoningControlForModels([ROTATE, ROTATE]);
    expect(control).not.toBeNull();
    expect(control!.options.map((o) => o.value)).toEqual([...ALL_LLM_REASONING_EFFORTS]);
    expect(control!.label).toBe("Reasoning / Thinking Effort");
    // The stored effort stays representable — "medium" is shown as "medium", not clamped away.
    expect(normalizeReasoningValueForControl([ROTATE, ROTATE], control, "medium")).toBe("medium");
    expect(normalizeReasoningValueForControl([ROTATE, ROTATE], control, undefined)).toBe("medium");
  });

  it("rotate + concrete model intersects down to the concrete model's own ladder", () => {
    const control = reasoningControlForModels([ROTATE, "gpt-5.4-mini"]);
    expect(control).not.toBeNull();
    expect(control!.options.map((o) => o.value)).toEqual(["low", "medium", "high"]);
    expect(control!.label).toBe("Shared Reasoning / Thinking");
    expect(normalizeReasoningValueForControl([ROTATE, "gpt-5.4-mini"], control, "medium")).toBe("medium");
  });

  it("rotate + a model with NO reasoning capability still shows the rotation ladder", () => {
    // mistral-small-2603 takes no reasoning params (provider 400) — it contributes no capability,
    // so the rotating seat's full ladder is what remains.
    const control = reasoningControlForModels([ROTATE, "mistral-small-2603"]);
    expect(control).not.toBeNull();
    expect(control!.options.map((o) => o.value)).toEqual([...ALL_LLM_REASONING_EFFORTS]);
  });

  it("models with no capability at all still yield no control (honest absence)", () => {
    expect(reasoningControlForModels(["mistral-small-2603"])).toBeNull();
    expect(reasoningControlForModels(["gpt-4.1-mini", "mistral-small-2603"])).toBeNull();
  });
});

describe("reasoningSummary — honest copy under rotation", () => {
  it("never claims rotating seats 'do not expose' a reasoning control", () => {
    const control = reasoningControlForModels([ROTATE, ROTATE]);
    const summary = reasoningSummary(control);
    expect(summary).not.toMatch(/do not expose/i);
    expect(summary).toMatch(/served model/i);
    expect(summary).toMatch(/clamped/i);
  });

  it("keeps the plain copy for concrete models and the honest-absence line for none", () => {
    expect(reasoningSummary(reasoningControlForModels(["gpt-5.4-mini"]))).toBe("OpenAI Reasoning active.");
    expect(reasoningSummary(null)).toMatch(/do not expose/i);
  });
});

describe("normalizeReasoningValueForControl — high-tier-only pairings (no silent escalation)", () => {
  it("mistral-medium-3-5 + gpt-5.4 collapses to {high}; non-explicit efforts stay unset", () => {
    const models = ["mistral-medium-3-5", "gpt-5.4"];
    const control = reasoningControlForModels(models);
    expect(control).not.toBeNull();
    expect(control!.options.map((o) => o.value)).toEqual(["high"]);
    // Every shared option is high-tier — the UI uses this to offer the explicit
    // "Per-model default" blank option instead of hiding the whole control.
    expect(control!.options.every((o) => HIGH_TIER_REASONING_EFFORTS.has(o.value))).toBe(true);
    // A non-explicit stored effort must NOT silently map onto the expensive high tier...
    expect(normalizeReasoningValueForControl(models, control, "medium")).toBeUndefined();
    expect(normalizeReasoningValueForControl(models, control, undefined)).toBeUndefined();
    // ...but an explicit high-tier request passes through (the opt-in path the blank option enables).
    expect(normalizeReasoningValueForControl(models, control, "high")).toBe("high");
  });

  it("rotate + mistral-medium-3-5 shares {none, high} and keeps the same opt-in guard", () => {
    const models = [ROTATE, "mistral-medium-3-5"];
    const control = reasoningControlForModels(models);
    expect(control!.options.map((o) => o.value)).toEqual(["none", "high"]);
    expect(normalizeReasoningValueForControl(models, control, "medium")).toBeUndefined();
    expect(normalizeReasoningValueForControl(models, control, "none")).toBe("none");
    expect(normalizeReasoningValueForControl(models, control, "xhigh")).toBe("high");
  });
});

describe("reasoningPatchFor — rotating seats never renormalize the stored effort", () => {
  it("all-rotate yields an empty patch (stored effort is clamped per served model at call time)", () => {
    expect(reasoningPatchFor([ROTATE, ROTATE], "medium")).toEqual({});
    expect(reasoningPatchFor([ROTATE, ROTATE], "xhigh")).toEqual({});
  });

  it("rotate + concrete renormalizes against the concrete seat only", () => {
    // gpt-5.4-mini's ladder is {low, medium, high}: "xhigh" clamps to "high" for the save.
    expect(reasoningPatchFor([ROTATE, "gpt-5.4-mini"], "xhigh")).toEqual({ llmReasoningEffort: "high" });
    expect(reasoningPatchFor([ROTATE, "gpt-5.4-mini"], "medium")).toEqual({ llmReasoningEffort: "medium" });
  });
});
