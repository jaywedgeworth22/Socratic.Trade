"use client";

/** Daily learning review — once per UTC day a frontier-class model audits the
 *  system's learning decisions (recent learned facts + the pending approval
 *  queue) against a system-history digest, catching lessons whose evidence was
 *  corrupted by an execution defect (e.g. losses from a stuck exit blamed on
 *  the thesis). Three USER-LEVEL fields (one config for your whole login — the
 *  review runs once per user per day, not per account), saved through the same
 *  PUT /api/policy path as every other settings card:
 *    learningReviewEnabled — the on/off switch (default off);
 *    learningReviewMode    — decide (apply verdicts, default) vs annotate (notify only);
 *    learningReviewModel   — the model that runs the review (default claude-fable-5,
 *                            an explicit value — never a blank that secretly means Fable). */

import { useState } from "react";
import { savePolicy, ConsoleApiError } from "../lib/api";
import { useConsoleData } from "../lib/useConsoleData";
import { useToast } from "../ui/toast";
import { Card, Field, Select, Toggle } from "../ui/primitives";

const MODE_OPTIONS = [
  {
    value: "annotate",
    label: "Annotate — record verdicts, change nothing",
    title: "Verdicts land in the activity log plus a daily notification. No learned fact or pending item is touched."
  },
  {
    value: "decide",
    label: "Decide — apply verdicts automatically",
    title: "Rejected facts are removed, expired facts stop informing runs, and pending items are approved or rejected per the verdict. Every application is audited."
  }
] as const;

// Model shortlist: this is a once-a-day audit of decisions that compound, so the curated
// options are frontier-tier; the review model is its own user-level pick (unrelated to the
// per-account team models on Framework → Models). No blank/"default" pseudo-option — the
// field always holds a real, chosen model.
const REVIEW_MODEL_OPTIONS = [
  { value: "claude-fable-5", label: "claude-fable-5 — most capable Claude · $$$" },
  { value: "claude-opus-4-8", label: "claude-opus-4-8 — premium Claude reasoning · $$$" },
  { value: "gpt-5.5", label: "gpt-5.5 — deepest OpenAI reasoning · $$$" },
  { value: "gpt-5.4", label: "gpt-5.4 — stronger OpenAI analysis · $$$" },
  { value: "gemini-3.1-pro-preview", label: "gemini-3.1-pro-preview — deepest Gemini reasoning · $$$" }
];

export function LearningReviewCard() {
  const { snapshot, refresh } = useConsoleData();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const policy = snapshot?.policy;
  if (!snapshot || !policy) return null;

  const enabled = policy.learningReviewEnabled === true;
  // "decide" is the default; only an explicit "annotate" opts out.
  const mode = policy.learningReviewMode === "annotate" ? "annotate" : "decide";
  // Real default value (never blank-means-Fable).
  const model = policy.learningReviewModel?.trim() || "claude-fable-5";
  const customModel = model && !REVIEW_MODEL_OPTIONS.some((o) => o.value === model) ? model : null;

  const save = async (patch: Record<string, unknown>, saved: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await savePolicy(patch);
      await refresh();
      toast.push("pos", saved);
    } catch (error) {
      toast.push("neg", "Not saved", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Daily learning review">
      <p className="mb-3 text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-faint)]">
        Once a day, a frontier-class model re-examines what the system has been learning — recent learned facts and the
        pending approval queue — against the system&apos;s own recent failures and fixes. It catches lessons built on
        corrupted evidence, like a thesis blamed for losses a stuck exit order actually caused. One review call per day.
      </p>
      <div className="flex flex-col gap-3">
        <div
          className="con-row flex items-center justify-between gap-4 rounded-md px-1.5 py-1.5"
          title="Run the review once per UTC day. Off = nothing runs and nothing is spent."
        >
          <div>
            <div className="text-[length:var(--con-fs-sm)] font-semibold">Run the daily review</div>
            <p className="mt-0.5 max-w-xl text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-muted)]">
              {enabled
                ? "On — the review runs once per day and posts its findings to the activity log and notifications."
                : "Off — no review runs, no model call is made."}
            </p>
          </div>
          <Toggle
            checked={enabled}
            disabled={busy}
            label="Run the daily review"
            onChange={(next) => void save({ learningReviewEnabled: next }, next ? "Daily learning review on" : "Daily learning review off")}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="When it disagrees with a lesson"
            hint="Annotate only flags; Decide also acts on the verdicts."
            htmlFor="learning-review-mode"
          >
            <Select
              id="learning-review-mode"
              value={mode}
              disabled={busy}
              title="Annotate records verdicts without changing anything. Decide applies them — removals, expiries, and pending approvals/rejections — each one audited."
              onChange={(e) =>
                void save(
                  { learningReviewMode: e.target.value },
                  e.target.value === "decide" ? "Review will apply its verdicts" : "Review will only annotate"
                )
              }
            >
              {MODE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value} title={o.title}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Learning-review model"
            hint="One call per day, so a frontier model is the point. Defaults to claude-fable-5."
            htmlFor="learning-review-model"
          >
            <Select
              id="learning-review-model"
              value={model}
              disabled={busy}
              title="The model that runs the daily learning review. Needs a resolvable key for its provider (Settings → API keys)."
              onChange={(e) => void save({ learningReviewModel: e.target.value }, "Learning-review model saved")}
            >
              {customModel && (
                <option value={customModel} title="A model id outside the curated list, kept exactly as stored.">
                  {customModel} — custom id
                </option>
              )}
              {REVIEW_MODEL_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </div>
    </Card>
  );
}
