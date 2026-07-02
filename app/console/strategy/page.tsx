"use client";

/** Strategy — how this account trades: the strategist's written instructions
 *  (prompt), the models, the eight scoring-factor weights, and the preset
 *  library. Always account-scoped; the header repeats the scope. Presets are
 *  copy-not-link and can never arm or disarm anything (server-enforced). */

import { useMemo, useState } from "react";
import type { ScoringWeights, StrategyTuningPatch, TradingPolicy } from "@/lib/types";
// Pure curated-model DATA (no legacy UI components) — the same catalog the rest
// of the app offers, so the console review picker stays consistent with it.
import { CURATED_LLM_MODEL_GROUPS } from "../../ui/llm-model-catalog";
import {
  activateProfile,
  copyProfileToAccount,
  savePolicy,
  tuneStrategy,
  ConsoleApiError,
  type StrategyTuneResult
} from "../lib/api";
import { activeConnectedAccount, deriveReality, type RealityInfo } from "../lib/derive";
import { EM_DASH } from "../lib/format";
import { classify, getAtPath, type FieldDef } from "../lib/policy-diff";
import { useConsoleData } from "../lib/useConsoleData";
import { useUnsavedChanges } from "../lib/useDirtyGuard";
import { ALL_DEFS } from "../guardrails/field-defs";
import { TypedConfirm } from "../components/chrome";
import { useToast } from "../ui/toast";
import { Ago, Btn, Card, Chip, Empty, Field, LiveTag, NumInput, Select, TextArea, TextInput } from "../ui/primitives";

/** Shipped default weights (src/lib/defaults.ts) — shown as ghost reference. */
const DEFAULT_WEIGHTS: ScoringWeights = {
  liquidity: 1.4,
  momentum: 1.2,
  value: 0.8,
  quality: 0.8,
  volatility: 0.8,
  sentiment: 0.6,
  positioning: 0.8,
  diversification: 1
};

const WEIGHT_KEYS = Object.keys(DEFAULT_WEIGHTS) as Array<keyof ScoringWeights>;

export default function StrategyPage() {
  const { snapshot, refresh } = useConsoleData();
  const toast = useToast();

  const [promptDraft, setPromptDraft] = useState<string | null>(null);
  const [modelDraft, setModelDraft] = useState<{ llmModel?: string; redTeamLlmModel?: string; llmReasoningEffort?: string } | null>(null);
  const [weightsDraft, setWeightsDraft] = useState<Partial<Record<keyof ScoringWeights, number>> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reality = useMemo(() => (snapshot ? deriveReality(snapshot) : null), [snapshot]);
  // Unsaved-draft registration must run unconditionally (before the null return).
  useUnsavedChanges(
    (promptDraft !== null && promptDraft !== snapshot?.strategyPrompt) || modelDraft !== null || weightsDraft !== null
  );
  if (!snapshot || !reality) return null;

  const policy = snapshot.policy;
  const activeAccount = activeConnectedAccount(snapshot);
  const prompt = promptDraft ?? snapshot.strategyPrompt;
  const promptDirty = promptDraft !== null && promptDraft !== snapshot.strategyPrompt;

  const save = async (label: string, body: Record<string, unknown>, after?: () => void) => {
    setBusy(label);
    try {
      await savePolicy(body);
      await refresh();
      after?.();
      toast.push("pos", `${label} saved`, "Takes effect on the next run.");
    } catch (error) {
      toast.push("neg", `${label} not saved`, error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-[length:var(--con-fs-lg)] font-bold">Strategy</h1>
        <Chip tone={reality.tone}>
          {reality.word} · {reality.phrase}
        </Chip>
        <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          for {reality.account?.label ?? "the local simulator"} — each account has its own strategy
        </span>
      </div>

      {/* Prompt */}
      <Card
        title="The strategist's written instructions"
        action={
          promptDirty ? (
            <div className="flex gap-2">
              <Btn variant="ghost" size="sm" onClick={() => setPromptDraft(null)}>
                Discard
              </Btn>
              <Btn variant="primary" size="sm" disabled={busy !== null} onClick={() => void save("Prompt", { strategyPrompt: promptDraft }, () => setPromptDraft(null))}>
                {busy === "Prompt" ? "Saving…" : "Save prompt"}
              </Btn>
            </div>
          ) : undefined
        }
      >
        <p className="mb-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          Free-text brief the proposer LLM runs under: objective, selection logic, sell rules, sizing guidance, output
          contract. The deterministic policy gate still constrains everything it proposes.
        </p>
        <TextArea rows={16} value={prompt} onChange={(e) => setPromptDraft(e.target.value)} spellCheck={false} />
      </Card>

      {/* Models */}
      <Card
        title="Models"
        action={
          modelDraft ? (
            <div className="flex gap-2">
              <Btn variant="ghost" size="sm" onClick={() => setModelDraft(null)}>
                Discard
              </Btn>
              <Btn variant="primary" size="sm" disabled={busy !== null} onClick={() => void save("Models", modelDraft, () => setModelDraft(null))}>
                {busy === "Models" ? "Saving…" : "Save models"}
              </Btn>
            </div>
          ) : undefined
        }
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Proposer model" hint="The bull-side strategist." htmlFor="llm-model">
            <TextInput
              id="llm-model"
              value={modelDraft?.llmModel ?? policy.llmModel ?? ""}
              onChange={(e) => setModelDraft((d) => ({ ...(d ?? {}), llmModel: e.target.value }))}
            />
          </Field>
          <Field
            label="Red-team model"
            hint="The bear-side reviewer that tries to kill high-conviction ideas. Blank = same as proposer."
            htmlFor="rt-model"
          >
            <TextInput
              id="rt-model"
              value={modelDraft?.redTeamLlmModel ?? policy.redTeamLlmModel ?? ""}
              placeholder="same as proposer"
              onChange={(e) => setModelDraft((d) => ({ ...(d ?? {}), redTeamLlmModel: e.target.value }))}
            />
          </Field>
          <Field label="Reasoning effort" htmlFor="effort">
            <Select
              id="effort"
              value={modelDraft?.llmReasoningEffort ?? policy.llmReasoningEffort ?? "medium"}
              onChange={(e) => setModelDraft((d) => ({ ...(d ?? {}), llmReasoningEffort: e.target.value }))}
            >
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </Select>
          </Field>
        </div>
      </Card>

      {/* Scoring weights */}
      <Card
        title="Scoring-factor weights"
        action={
          weightsDraft ? (
            <div className="flex gap-2">
              <Btn variant="ghost" size="sm" onClick={() => setWeightsDraft(null)}>
                Discard
              </Btn>
              <Btn
                variant="primary"
                size="sm"
                disabled={busy !== null}
                onClick={() => void save("Weights", { scoringWeights: weightsDraft }, () => setWeightsDraft(null))}
              >
                {busy === "Weights" ? "Saving…" : "Save weights"}
              </Btn>
            </div>
          ) : undefined
        }
      >
        <p className="mb-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          The market scan ranks candidates by these eight factors before the strategist ever sees them. Defaults shown
          under each field.
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {WEIGHT_KEYS.map((key) => {
            const current = weightsDraft?.[key] ?? policy.scoringWeights?.[key] ?? DEFAULT_WEIGHTS[key];
            return (
              <Field key={key} label={key} hint={`default ${DEFAULT_WEIGHTS[key]}`} htmlFor={`w-${key}`}>
                <NumInput
                  id={`w-${key}`}
                  step="0.1"
                  min="0"
                  value={String(current)}
                  onChange={(e) =>
                    setWeightsDraft((d) => ({ ...(d ?? {}), [key]: e.target.value === "" ? DEFAULT_WEIGHTS[key] : Number(e.target.value) }))
                  }
                />
              </Field>
            );
          })}
        </div>
      </Card>

      {/* AI review */}
      <AiReviewPanel policy={policy} strategyPrompt={snapshot.strategyPrompt} reality={reality} />

      {/* Presets */}
      <Card title="Preset library">
        <p className="mb-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          Applying a preset copies its policy, prompt, and weights onto the active account — copy, not link: later edits
          to the preset never follow. A preset can never start or stop the strategy; your run state is always preserved.
        </p>
        {snapshot.profiles.length === 0 ? (
          <Empty>No presets saved yet.</Empty>
        ) : (
          <div className="flex flex-col gap-2">
            {snapshot.profiles.map((profile) => {
              // "applied" = what THIS account is running (policy.activeProfileId,
              // stamped by the copy/apply path). Fall back to the library active
              // flag only when the account has never had a preset applied.
              const applied = policy.activeProfileId ? policy.activeProfileId === profile.id : profile.active;
              return (
                <div key={profile.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[color:var(--con-line)] p-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{profile.name || EM_DASH}</span>
                      {applied && <Chip tone="accent">applied here</Chip>}
                    </div>
                    <div className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                      updated <Ago iso={profile.updatedAt} />
                    </div>
                  </div>
                  {!applied && (
                    <Btn
                      size="sm"
                      disabled={busy !== null}
                      onClick={async () => {
                        setBusy(`profile-${profile.id}`);
                        try {
                          if (activeAccount) {
                            // Preferred path: POST /api/profiles/[id]/copy — writes ONLY this
                            // account's live strategy state and preserves its run-state and the
                            // library active flag (applyProfileToAccount, server-enforced).
                            await copyProfileToAccount(profile.id, activeAccount.id);
                            toast.push("pos", `Applied “${profile.name}”`, "Copied onto this account. Run state unchanged.");
                          } else {
                            // No connected account (fresh local install): the copy route has no
                            // target, so fall back to library activation of the base policy.
                            await activateProfile(profile.id);
                            toast.push("pos", `Activated “${profile.name}”`, "Applied as the base strategy for the local simulator.");
                          }
                          await refresh();
                        } catch (error) {
                          toast.push("neg", "Preset not applied", error instanceof ConsoleApiError ? error.message : String(error));
                        } finally {
                          setBusy(null);
                        }
                      }}
                    >
                      {busy === `profile-${profile.id}` ? "Applying…" : "Apply to this account"}
                    </Btn>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

// ── AI review (#12) ──────────────────────────────────────────────────────────

interface ReviewChange {
  key: string;
  label: string;
  from: string;
  to: string;
  direction: "looser" | "tighter" | "changed";
}

const DEFS_BY_PATH = new Map<string, FieldDef>(ALL_DEFS.map((def) => [def.path, def]));

function fmtRaw(def: FieldDef | undefined, value: unknown): string {
  if (value === undefined || value === null || value === "") return "unset";
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value === "number") {
    if (def?.kind === "money") return `$${value}`;
    if (def?.kind === "pct") return `${value}%`;
    if (def?.kind === "minutes") return `${value} min`;
    if (def?.kind === "seconds") return `${value} s`;
    return String(value);
  }
  return String(value);
}

/** Flatten the tune proposal's policy/weights patch into labeled from→to rows,
 *  classified LOOSER/TIGHTER via the same guardrail metadata the Guardrails
 *  editor uses — so LIVE loosening costs the same typed word here too. */
function reviewChanges(patch: StrategyTuningPatch, policy: TradingPolicy): ReviewChange[] {
  const rows: ReviewChange[] = [];

  const push = (path: string, label: string, from: unknown, to: unknown, direction?: ReviewChange["direction"]) => {
    const same = (from === undefined && to === undefined) || from === to;
    if (same) return;
    const def = DEFS_BY_PATH.get(path);
    rows.push({
      key: path,
      label,
      from: fmtRaw(def, from),
      to: fmtRaw(def, to),
      direction: direction ?? (def ? classify(def, from, to) : "changed")
    });
  };

  for (const [k, v] of Object.entries(patch.scoringWeights ?? {})) {
    push(`scoringWeights.${k}`, `Weight: ${k}`, policy.scoringWeights?.[k as keyof ScoringWeights], v);
  }

  const p = patch.policy ?? {};
  for (const [k, v] of Object.entries(p)) {
    if (k === "riskRules" || k === "sectorCaps") continue;
    if (k === "strategyAuthority") {
      const from = policy.strategyAuthority;
      if (v !== from) {
        // propose→decide arms Autopilot — the loosest possible move.
        push(k, "Autonomy", from === "decide" ? "Autopilot" : "Ask-first", v === "decide" ? "Autopilot" : "Ask-first", v === "decide" ? "looser" : "tighter");
      }
      continue;
    }
    push(k, DEFS_BY_PATH.get(k)?.label ?? k, getAtPath(policy, k), v);
  }
  for (const [k, v] of Object.entries(p.riskRules ?? {})) {
    push(`riskRules.${k}`, DEFS_BY_PATH.get(`riskRules.${k}`)?.label ?? `riskRules.${k}`, getAtPath(policy, `riskRules.${k}`), v);
  }
  for (const [k, v] of Object.entries(p.sectorCaps ?? {})) {
    const from = policy.sectorCaps?.[k];
    if (from === v) continue;
    rows.push({
      key: `sectorCaps.${k}`,
      label: `Sector cap: ${k}`,
      from: from === undefined ? "unset" : `${from}%`,
      to: `${v}%`,
      // Raising a sector cap allows more concentration — looser.
      direction: typeof from === "number" ? (v > from ? "looser" : "tighter") : "changed"
    });
  }
  return rows;
}

function AiReviewPanel({
  policy,
  strategyPrompt,
  reality
}: {
  policy: TradingPolicy;
  strategyPrompt: string;
  reality: RealityInfo;
}) {
  const { refresh } = useConsoleData();
  const toast = useToast();
  const [model, setModel] = useState<string>("");
  const [busy, setBusy] = useState<"review" | "apply" | null>(null);
  const [review, setReview] = useState<StrategyTuneResult | null>(null);
  const [typed, setTyped] = useState("");
  useUnsavedChanges(review !== null);

  const changes = useMemo(() => (review ? reviewChanges(review.proposedPatch, policy) : []), [review, policy]);
  const promptChanged = Boolean(review?.proposedPatch.prompt && review.proposedPatch.prompt !== strategyPrompt);
  const hasAnyChange = changes.length > 0 || promptChanged;
  const hasLooser = changes.some((c) => c.direction === "looser");
  const needsTyped = reality.tone === "live" && hasLooser;

  const generate = async () => {
    setBusy("review");
    try {
      const result = await tuneStrategy(model || undefined);
      setReview(result);
      setTyped("");
    } catch (error) {
      toast.push("neg", "Review failed", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    if (!review) return;
    const patch = review.proposedPatch;
    setBusy("apply");
    try {
      const { riskRules, sectorCaps, ...policyRest } = patch.policy ?? {};
      // Same write path as every other strategy edit: PUT /api/policy. The server
      // deep-merges scoringWeights/riskRules; sectorCaps is whole-replace, so merge
      // over the current caps here to keep untouched sectors intact.
      await savePolicy({
        ...policyRest,
        ...(riskRules ? { riskRules } : {}),
        ...(sectorCaps ? { sectorCaps: { ...policy.sectorCaps, ...sectorCaps } } : {}),
        ...(patch.scoringWeights ? { scoringWeights: patch.scoringWeights } : {}),
        ...(patch.prompt ? { strategyPrompt: patch.prompt } : {})
      });
      await refresh();
      setReview(null);
      setTyped("");
      toast.push("pos", "Review changes applied", "Takes effect on the next run.");
    } catch (error) {
      toast.push("neg", "Not applied", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card
      title="AI review"
      action={
        review ? (
          <Btn variant="ghost" size="sm" disabled={busy !== null} onClick={() => { setReview(null); setTyped(""); }}>
            Discard
          </Btn>
        ) : undefined
      }
    >
      <p className="mb-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        A reviewer model reads this account&apos;s recent performance, missed opportunities, factor evidence, and the
        market backdrop, then proposes prompt/weight/guardrail changes. Nothing is applied until you review the exact
        diff and commit it — the same rules as editing by hand, including the typed word for LIVE loosening.
      </p>

      {!review ? (
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-64">
            <Field label="Reviewer model" hint="Blank = the account's tuning default." htmlFor="ai-review-model">
              <Select id="ai-review-model" value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="">account default</option>
                {CURATED_LLM_MODEL_GROUPS.map((group) => (
                  <optgroup key={group.provider} label={group.label}>
                    {group.options.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            </Field>
          </div>
          <Btn variant="primary" disabled={busy !== null} onClick={() => void generate()}>
            {busy === "review" ? "Reviewing…" : "Generate review"}
          </Btn>
        </div>
      ) : (
        <div className="flex flex-col gap-3 text-[length:var(--con-fs-sm)]">
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone={review.generatedBy === "llm" ? "accent" : "muted"}>
              {review.generatedBy === "llm" ? "LLM review" : "local rules (no LLM)"}
            </Chip>
            <span className="con-num text-[color:var(--con-muted)]">Confidence {review.confidenceScore}/100</span>
          </div>
          <p className="leading-relaxed">{review.summary}</p>
          {review.rationale && <p className="leading-relaxed text-[color:var(--con-muted)]">{review.rationale}</p>}
          {(review.marketContext || review.performanceReadout) && (
            <details className="con-disclosure">
              <summary>Evidence the reviewer saw</summary>
              <div className="flex flex-col gap-2 pb-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                {review.performanceReadout && <p>{review.performanceReadout}</p>}
                {review.marketContext && <p>{review.marketContext}</p>}
              </div>
            </details>
          )}
          {review.cautions.length > 0 && (
            <ul className="list-disc pl-4 text-[length:var(--con-fs-xs)] text-[color:var(--con-warn)]">
              {review.cautions.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          )}

          {/* The diff — exactly what Apply would write. */}
          <div className="rounded-lg border border-[color:var(--con-line)] p-3">
            <div className="con-card-title mb-1">Proposed changes</div>
            {!hasAnyChange ? (
              <p className="text-[color:var(--con-muted)]">No changes proposed — the reviewer left everything as is.</p>
            ) : (
              <div className="flex flex-col divide-y divide-[color:var(--con-line)]">
                {promptChanged && (
                  <details className="con-disclosure">
                    <summary>Prompt rewrite proposed</summary>
                    <div className="grid gap-2 pb-2 sm:grid-cols-2">
                      <div>
                        <div className="con-card-title mb-1">Current</div>
                        <pre className="con-mono max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-[color:var(--con-surface-2)] p-2 text-[10px] leading-relaxed">{strategyPrompt}</pre>
                      </div>
                      <div>
                        <div className="con-card-title mb-1">Proposed</div>
                        <pre className="con-mono max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-[color:var(--con-surface-2)] p-2 text-[10px] leading-relaxed">{review.proposedPatch.prompt}</pre>
                      </div>
                    </div>
                  </details>
                )}
                {changes.map((c) => (
                  <div key={c.key} className="flex items-center justify-between gap-3 py-1.5">
                    <span className="font-semibold">{c.label}</span>
                    <span className="con-num flex items-center gap-2">
                      <span className="text-[color:var(--con-faint)]">{c.from}</span>
                      <span className="text-[color:var(--con-faint)]">→</span>
                      <span>{c.to}</span>
                      {c.direction !== "changed" && (
                        <span
                          className="text-[length:var(--con-fs-xs)] font-bold uppercase"
                          style={{ color: c.direction === "looser" ? "var(--con-warn)" : "var(--con-pos)" }}
                        >
                          {c.direction}
                        </span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {hasAnyChange &&
            (needsTyped ? (
              <TypedConfirm
                phrase="CONFIRM"
                value={typed}
                onChange={setTyped}
                busy={busy === "apply"}
                variant="primary"
                confirmLabel={
                  <>
                    Apply review changes <LiveTag />
                  </>
                }
                note="At least one proposed change LOOSENS a limit on a LIVE (real money) account. Loosening costs a typed word here exactly like it does in Guardrails."
                onConfirm={() => void apply()}
              />
            ) : (
              <div className="flex justify-end gap-2">
                <Btn variant="ghost" disabled={busy !== null} onClick={() => { setReview(null); setTyped(""); }}>
                  Discard
                </Btn>
                <Btn variant="primary" disabled={busy !== null} onClick={() => void apply()}>
                  {busy === "apply" ? "Applying…" : "Apply changes"}
                </Btn>
              </div>
            ))}
        </div>
      )}
    </Card>
  );
}
