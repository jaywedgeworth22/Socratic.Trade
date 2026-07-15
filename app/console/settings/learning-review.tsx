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
import type { LlmReasoningEffort } from "@/lib/types";
import { normalizeReasoningEffortForModel, reasoningCapabilityForModel } from "@/lib/llm-request";
import { reasoningAdviceForModel, recommendedReasoningEffortForModel } from "@/lib/model-reasoning-recommendations";
import { savePolicy, ConsoleApiError } from "../lib/api";
import { useConsoleData } from "../lib/useConsoleData";
import { useToast } from "../ui/toast";
import { Card, Field, RawNumInput, Select, Toggle } from "../ui/primitives";
import { ListSection, ListRow, LabeledContent } from "../../ui/ios-components";

const DEFAULT_MIN_NEW_LESSONS = 5;
const DEFAULT_MAX_WAIT_DAYS = 7;

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
  { value: "gpt-5.6-sol", label: "gpt-5.6-sol — recommended frontier audit · $$$" },
  { value: "gpt-5.6-terra", label: "gpt-5.6-terra — balanced current-generation audit · $$$" },
  { value: "gpt-5.6-luna", label: "gpt-5.6-luna — lower-cost current-generation audit · $$" },
  { value: "claude-fable-5", label: "claude-fable-5 — most capable Claude · $$$" },
  { value: "claude-opus-4-8", label: "claude-opus-4-8 — premium Claude reasoning · $$$" },
  { value: "gemini-3.1-pro-preview", label: "gemini-3.1-pro-preview — deepest Gemini reasoning · $$$" }
];

export function LearningReviewCard() {
  const { snapshot, refresh } = useConsoleData();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<{ learningReviewMinNewLessons?: number; learningReviewMaxWaitDays?: number }>({});

  const policy = snapshot?.policy;
  if (!snapshot || !policy) return null;

  const enabled = policy.learningReviewEnabled === true;
  // "decide" is the default; only an explicit "annotate" opts out.
  const mode = policy.learningReviewMode === "annotate" ? "annotate" : "decide";
  // Real default value (never blank-means-Fable).
  const model = policy.learningReviewModel?.trim() || "claude-fable-5";
  const customModel = model && !REVIEW_MODEL_OPTIONS.some((o) => o.value === model) ? model : null;
  const reasoningCapability = reasoningCapabilityForModel(model);
  const recommendedEffort = recommendedReasoningEffortForModel(model, "review");
  const reasoningEffort = normalizeReasoningEffortForModel(
    model,
    policy.learningReviewReasoningEffort ?? recommendedEffort
  );
  const reasoningAdvice = reasoningAdviceForModel(model);
  const minNewLessons = draft.learningReviewMinNewLessons ?? policy.learningReviewMinNewLessons ?? DEFAULT_MIN_NEW_LESSONS;
  const maxWaitDays = draft.learningReviewMaxWaitDays ?? policy.learningReviewMaxWaitDays ?? DEFAULT_MAX_WAIT_DAYS;

  /** Returns whether the save succeeded, so numeric-field callers can revert their optimistic draft. */
  const save = async (patch: Record<string, unknown>, saved: string): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    try {
      await savePolicy(patch);
      await refresh();
      toast.push("pos", saved);
      return true;
    } catch (error) {
      toast.push("neg", "Not saved", error instanceof ConsoleApiError ? error.message : String(error));
      return false;
    } finally {
      setBusy(false);
    }
  };

  // Numeric trigger knobs: local text while typing, commit on blur (mirrors Market-scan shape).
  const commitNumber = (
    key: "learningReviewMinNewLessons" | "learningReviewMaxWaitDays",
    next: number,
    saved: number,
    label: string
  ) => {
    if (next === saved) return;
    void save({ [key]: next }, label).then((ok) => {
      if (!ok) setDraft((d) => ({ ...d, [key]: saved }));
    });
  };

  return (
    <ListSection title="Daily learning review">
      <div className="px-2 pb-2">
        <p className="mb-3 text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-faint)]">
          Once a day, a frontier-class model re-examines what the system has been learning — recent learned facts and the
          pending approval queue — against the system&apos;s own recent failures and fixes. It catches lessons built on
          corrupted evidence, like a thesis blamed for losses a stuck exit order actually caused. One review call per day.
        </p>
      </div>
      
      <ListRow>
        <LabeledContent label="Run the daily review" hint={enabled ? "On — posts findings to the activity log and notifications." : "Off — no review runs, no model call is made."}>
          <Toggle
            checked={enabled}
            disabled={busy}
            onChange={(next) => void save({ learningReviewEnabled: next }, next ? "Daily learning review on" : "Daily learning review off")}
          />
        </LabeledContent>
      </ListRow>

      {enabled && (
        <>
          <ListRow>
            <LabeledContent label="Run after this many new lessons" hint="Whichever fires first: this count, or the max wait below.">
              <RawNumInput
                id="learning-review-min-new-lessons"
                className="w-16 text-right bg-transparent border-0 px-0 text-[length:var(--con-fs-sm)] focus:ring-0"
                value={String(minNewLessons)}
                emptyValue={DEFAULT_MIN_NEW_LESSONS}
                disabled={busy}
                title="Skips the daily call entirely until at least this many learned facts or pending items have appeared since the last successful review."
                onValueChange={(parsed) => setDraft((d) => ({ ...d, learningReviewMinNewLessons: parsed }))}
                onBlur={() =>
                  commitNumber(
                    "learningReviewMinNewLessons",
                    minNewLessons,
                    policy.learningReviewMinNewLessons ?? DEFAULT_MIN_NEW_LESSONS,
                    "Threshold saved"
                  )
                }
              />
            </LabeledContent>
          </ListRow>
          <ListRow>
            <LabeledContent label="Or after this many days, whichever is first" hint="A slow trickle of lessons still gets swept eventually.">
              <RawNumInput
                id="learning-review-max-wait-days"
                className="w-16 text-right bg-transparent border-0 px-0 text-[length:var(--con-fs-sm)] focus:ring-0"
                value={String(maxWaitDays)}
                emptyValue={DEFAULT_MAX_WAIT_DAYS}
                disabled={busy}
                title="Even below the threshold, the review still runs once the oldest un-reviewed lesson has waited this many days."
                onValueChange={(parsed) => setDraft((d) => ({ ...d, learningReviewMaxWaitDays: parsed }))}
                onBlur={() =>
                  commitNumber(
                    "learningReviewMaxWaitDays",
                    maxWaitDays,
                    policy.learningReviewMaxWaitDays ?? DEFAULT_MAX_WAIT_DAYS,
                    "Max wait saved"
                  )
                }
              />
            </LabeledContent>
          </ListRow>
        </>
      )}

      <ListRow>
        <div className="w-full py-1">
          <LabeledContent label="When it disagrees with a lesson" hint="Annotate only flags; Decide also acts on the verdicts.">
            <select
              id="learning-review-mode"
              className="bg-transparent text-right text-[length:var(--con-fs-sm)] focus:outline-none focus:ring-0 cursor-pointer"
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
            </select>
          </LabeledContent>
        </div>
      </ListRow>

      <ListRow>
        <div className="w-full py-1">
          <LabeledContent label="Learning-review model" hint="One call per day, so a frontier model is the point. Defaults to claude-fable-5.">
            <select
              id="learning-review-model"
              className="bg-transparent text-right text-[length:var(--con-fs-sm)] focus:outline-none focus:ring-0 cursor-pointer max-w-[200px]"
              value={model}
              disabled={busy}
              title="The model that runs the daily learning review. Needs a resolvable key for its provider (Settings → API keys)."
              onChange={(e) => {
                const nextModel = e.target.value;
                void save(
                  {
                    learningReviewModel: nextModel,
                    learningReviewReasoningEffort: recommendedReasoningEffortForModel(nextModel, "review")
                  },
                  "Learning-review model and recommended effort saved"
                );
              }}
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
            </select>
          </LabeledContent>
        </div>
      </ListRow>

      {reasoningCapability && reasoningEffort && (
        <ListRow>
          <div className="w-full py-1">
            <LabeledContent
              label={reasoningCapability.settingLabel}
              hint={`Recommended for this review role: ${recommendedEffort}. ${reasoningCapability.description}`}
            >
              <select
                id="learning-review-reasoning-effort"
                className="bg-transparent text-right text-[length:var(--con-fs-sm)] focus:outline-none focus:ring-0 cursor-pointer"
                value={reasoningEffort}
                disabled={busy}
                title={reasoningAdvice ?? reasoningCapability.description}
                onChange={(e) =>
                  void save(
                    { learningReviewReasoningEffort: e.target.value as LlmReasoningEffort },
                    "Learning-review reasoning effort saved"
                  )
                }
              >
                {reasoningCapability.options.map((option) => (
                  <option key={option.value} value={option.value} title={option.hint}>
                    {option.label}{option.value === recommendedEffort ? " — recommended" : ""}
                  </option>
                ))}
              </select>
            </LabeledContent>
            {reasoningAdvice && (
              <p className="mt-1 text-right text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                {reasoningAdvice}
              </p>
            )}
          </div>
        </ListRow>
      )}
    </ListSection>
  );
}
