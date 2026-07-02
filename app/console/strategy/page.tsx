"use client";

/** Strategy — how this account trades: the strategist's written instructions
 *  (prompt), the models, the eight scoring-factor weights, and the preset
 *  library. Always account-scoped; the header repeats the scope. Presets are
 *  copy-not-link and can never arm or disarm anything (server-enforced). */

import { useMemo, useState } from "react";
import type { ScoringWeights } from "@/lib/types";
import { activateProfile, copyProfileToAccount, savePolicy, ConsoleApiError } from "../lib/api";
import { activeConnectedAccount, deriveReality } from "../lib/derive";
import { EM_DASH } from "../lib/format";
import { useConsoleData } from "../lib/useConsoleData";
import { useToast } from "../ui/toast";
import { Ago, Btn, Card, Chip, Empty, Field, NumInput, Select, TextArea, TextInput } from "../ui/primitives";

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
