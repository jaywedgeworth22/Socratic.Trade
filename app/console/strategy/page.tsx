"use client";

/** Strategy — how this account trades: the strategist's written instructions
 *  (prompt), the models, the eight scoring-factor weights, and the preset
 *  library. Always account-scoped; the header repeats the scope. Presets are
 *  copy-not-link and can never arm or disarm anything (server-enforced). */

import { useMemo, useState } from "react";
import { Lock, Unlock } from "lucide-react";
import type { LlmReasoningEffort, ScoringWeights, StrategyTuningPatch, TradingPolicy } from "@/lib/types";
import { reasoningCapabilityForModel } from "@/lib/llm-request";
import {
  HIGH_TIER_REASONING_EFFORTS,
  normalizeReasoningValueForControl,
  reasoningControlForModels,
  reasoningPatchFor,
  reasoningSummary
} from "./reasoning-control";
// Pure curated-model DATA (no legacy UI components) — the same catalog the rest
// of the app offers, so the console review picker stays consistent with it.
import { CURATED_LLM_MODEL_GROUPS, CURATED_LLM_MODEL_IDS, CUSTOM_MODEL_ID_SEED, ROTATE_ALL_MODELS_ID, ROTATE_ALL_MODELS_LABEL } from "../../ui/llm-model-catalog";
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
import { CONSOLE_PAGE_WIDTH } from "../lib/page-width";
import { useAutoSave } from "../lib/useAutoSave";
import { useConsoleData } from "../lib/useConsoleData";
import { useUnsavedChanges } from "../lib/useDirtyGuard";
import { ALL_DEFS } from "../guardrails/field-defs";
import { TypedConfirm } from "../components/chrome";
import { ModelStatsButton } from "../components/model-stats-drawer";
import { useToast } from "../ui/toast";
import { Ago, Btn, Card, Chip, Empty, Field, LiveTag, RawNumInput, Select, TextArea, TextInput, Tooltip } from "../ui/primitives";
import { SaveStatus } from "../ui/save-status";

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

/** Human-readable name + hover explanation for each scoring factor. Display-only —
 *  does not touch the scoring math in src/lib/scoring.ts (or wherever weights are applied). */
const FACTOR_META: Record<keyof ScoringWeights, { name: string; tip: string }> = {
  liquidity: {
    name: "Liquidity",
    tip: "How easily you can trade the stock, from recent share volume. More weight favors high-volume names you can enter and exit cleanly, and penalizes thin, illiquid ones."
  },
  momentum: {
    name: "Momentum",
    tip: "Recent trend strength: intraday move, position within the 52-week range, and technical signals (RSI/MACD/moving averages). More weight favors names that are rising and near their highs."
  },
  value: {
    name: "Value",
    tip: "Cheapness from P/E and free-cash-flow yield. More weight tilts toward low-multiple, cash-generative names and away from expensive ones."
  },
  quality: {
    name: "Quality",
    tip: "Financial sturdiness: company size, low debt, and earnings growth. More weight favors large, low-leverage, profitably growing companies."
  },
  volatility: {
    name: "Volatility",
    tip: "Steadiness, not choppiness — the score is highest for calm, low-beta names. Counter-intuitively, more weight here favors steady stocks and penalizes sharp movers and high-beta risk."
  },
  sentiment: {
    name: "Sentiment",
    tip: "Aggregate news, analyst, and market sentiment (0–100). More weight favors positively-covered names and discounts negatively-covered ones."
  },
  positioning: {
    name: "Positioning",
    tip: "Smart-money accumulation: net congressional buying, insider open-market purchases (SEC Form 4), and short-squeeze setups. More weight favors names insiders and Congress are buying."
  },
  diversification: {
    name: "Diversification",
    tip: "Portfolio fit: a name you don't already hold scores higher than one you do. More weight pushes toward new positions instead of adding to what you already own — it's held-vs-not, not sector spread."
  }
};

const CUSTOM_MODEL_OPTION = CUSTOM_MODEL_ID_SEED;

function isCuratedModel(model: string | undefined): boolean {
  return !!model && CURATED_LLM_MODEL_IDS.includes(model);
}

function modelSelectValue(model: string | undefined): string {
  if (!model) return "";
  return model;
}

function modelProviderLabel(model: string | undefined): string {
  if (!model) return "Not Set";
  if (model === ROTATE_ALL_MODELS_ID) return "Rotating (a different model each run)";
  const group = CURATED_LLM_MODEL_GROUPS.find((g) => g.options.some((option) => option.value === model));
  return group?.label ?? "Custom Provider";
}

function ModelSelect({
  id,
  value,
  onPick,
  onCustomTextChange,
  onCustomTextBlur,
  disabled,
  allowBlank,
  blankLabel,
  role
}: {
  id: string;
  value: string | undefined;
  /** A concrete model choice from the dropdown (curated id, blank, or rotate) — persist immediately. */
  onPick: (model: string) => void;
  /** Local-only update per keystroke while typing a custom id — never persists. */
  onCustomTextChange: (text: string) => void;
  /** Persist the typed custom id (if any) on blur. */
  onCustomTextBlur: () => void;
  disabled?: boolean;
  allowBlank?: boolean;
  blankLabel?: string;
  role: "proposer" | "red-team";
}) {
  const selectValue = modelSelectValue(value);
  const custom = selectValue === CUSTOM_MODEL_OPTION;
  const customCurrent = value && !isCuratedModel(value) && value !== CUSTOM_MODEL_OPTION && value !== ROTATE_ALL_MODELS_ID ? value : null;
  return (
    <div className="flex flex-col gap-2">
      <Select
        id={id}
        value={selectValue}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value;
          if (next === CUSTOM_MODEL_OPTION) {
            // Entering (or re-entering) custom-id entry mode is a UI-mode switch, not a concrete
            // model choice — don't persist until a real id is typed and blurred.
            onCustomTextChange(custom ? (value ?? CUSTOM_MODEL_OPTION) : CUSTOM_MODEL_OPTION);
            return;
          }
          onPick(next);
        }}
      >
        {allowBlank && <option value="">{blankLabel ?? "Not Set"}</option>}
        <option
          value={ROTATE_ALL_MODELS_ID}
          title="Round-robins every curated model with a resolvable key — a different model each run, so comparative history accrues across models. Intended for paper/test accounts."
        >
          {ROTATE_ALL_MODELS_LABEL}
        </option>
        {customCurrent && (
          <option value={customCurrent} title="A model id outside the curated list, kept exactly as stored.">
            {customCurrent} - custom id
          </option>
        )}
        {CURATED_LLM_MODEL_GROUPS.map((group) => (
          <optgroup key={group.provider} label={group.label}>
            {group.options.map((option) => {
              const label = role === "proposer" && option.recommendedGreen
                ? `${option.label} (Rec Proposer)`
                : role === "red-team" && option.recommendedRed
                ? `${option.label} (Rec Reviewer)`
                : option.label;
              return (
                <option key={option.value} value={option.value}>
                  {label}
                </option>
              );
            })}
          </optgroup>
        ))}
        <option value={CUSTOM_MODEL_OPTION}>Custom Model ID...</option>
      </Select>
      {custom && (
        <TextInput
          value={value && value !== CUSTOM_MODEL_OPTION ? value : ""}
          placeholder="provider-model-id"
          onChange={(event) => onCustomTextChange(event.target.value)}
          onBlur={onCustomTextBlur}
          title="Type an exact provider model ID if it is not in the curated list. Saves when you click away."
        />
      )}
    </div>
  );
}

export default function StrategyPage() {
  const { snapshot, refresh } = useConsoleData();
  const toast = useToast();

  // Prompt: local text while typing, persist on blur (see commitPrompt below).
  const [promptDraft, setPromptDraft] = useState<string | null>(null);
  const autoSavePrompt = useAutoSave();
  // Models: sticky optimistic overlay per field — each select persists immediately on
  // change; the custom-id text fields persist on blur. Reverted by useAutoSave's onError.
  const [localProposerModel, setLocalProposerModel] = useState<string | null>(null);
  const [localRedTeamModel, setLocalRedTeamModel] = useState<string | null>(null);
  // "cleared" = an optimistic explicit-unset (the "Per-model default" option) awaiting the server
  // round-trip; null = no local overlay (fall back to the saved policy value).
  const [localReasoningEffort, setLocalReasoningEffort] = useState<LlmReasoningEffort | "cleared" | null>(null);
  const autoSaveModels = useAutoSave();
  // Scoring weights: local text while typing each factor, persist on blur (per-field patch —
  // the server deep-merges scoringWeights, see commitWeight below).
  const [weightsOverlay, setWeightsOverlay] = useState<Partial<Record<keyof ScoringWeights, number>>>({});
  const autoSaveWeights = useAutoSave();
  // Presets ("Apply to this account") is a discrete action button, not auto-saved.
  const [busy, setBusy] = useState<string | null>(null);

  const reality = useMemo(() => (snapshot ? deriveReality(snapshot) : null), [snapshot]);
  if (!snapshot || !reality) return null;

  const policy = snapshot.policy;
  const activeAccount = activeConnectedAccount(snapshot);
  const prompt = promptDraft ?? snapshot.strategyPrompt;
  const proposerModel = localProposerModel ?? policy.llmModel ?? "";
  const redTeamModel = localRedTeamModel ?? policy.redTeamLlmModel ?? "";
  const effectiveRedTeamModel = redTeamModel || proposerModel;
  // The rotation sentinel is neither a custom id (it only ever serves curated models, so the
  // custom-cost-fallback warning doesn't apply) nor a model with its own reasoning capability.
  const isRotate = (m: string) => m === ROTATE_ALL_MODELS_ID;
  const showCustomModelWarning =
    (proposerModel && !isCuratedModel(proposerModel) && !isRotate(proposerModel)) ||
    (effectiveRedTeamModel && !isCuratedModel(effectiveRedTeamModel) && !isRotate(effectiveRedTeamModel));
  const rotationSelected = isRotate(proposerModel) || isRotate(effectiveRedTeamModel);
  // A rotating seat is NOT filtered out: it maps to the synthetic full-ladder rotation capability
  // (see reasoning-control.ts), so the effort control stays visible/editable under rotation — the
  // stored effort still applies per served model at call time, clamped per model.
  const reasoningModels = [proposerModel, effectiveRedTeamModel];
  const reasoningControl = reasoningControlForModels(reasoningModels);
  const storedReasoningEffort = localReasoningEffort === "cleared" ? undefined : (localReasoningEffort ?? policy.llmReasoningEffort);
  const reasoningValue = reasoningControl
    ? normalizeReasoningValueForControl(reasoningModels, reasoningControl, storedReasoningEffort)
    : undefined;
  // Mixed pairings whose SHARED option set is high-tier only (e.g. mistral-medium-3-5 + gpt-5.4:
  // {high}) normalize every non-explicit stored effort to undefined (the no-silent-escalation
  // guard in normalizeReasoningValueForControl). Instead of hiding the whole control — which left
  // no way to even opt INTO the high tier — render it with an explicit "Per-model default" blank
  // option. The blank option also stays available while the only shared values are high-tier, so
  // choosing High is never a one-way door.
  const reasoningHighTierOnly = reasoningControl ? reasoningControl.options.every((o) => HIGH_TIER_REASONING_EFFORTS.has(o.value)) : false;
  const showPerModelDefaultOption = Boolean(reasoningControl) && (reasoningValue === undefined || reasoningHighTierOnly);
  // Selected concrete models that take NO reasoning parameters at all (e.g. mistral-small-2603)
  // while another selected seat still shows the control — disclose that the setting skips them.
  const modelsIgnoringReasoning = reasoningControl
    ? Array.from(new Set(reasoningModels.map((m) => m.trim()).filter(Boolean))).filter((m) => !isRotate(m) && !reasoningCapabilityForModel(m))
    : [];

  // Prompt: skip the write if blur leaves it unchanged from the saved copy.
  const commitPrompt = () => {
    if (promptDraft === null || promptDraft === snapshot.strategyPrompt) return;
    const next = promptDraft;
    const prev = snapshot.strategyPrompt;
    autoSavePrompt.save(() => savePolicy({ strategyPrompt: next }).then(() => refresh()), {
      onError: () => setPromptDraft(prev),
      errorTitle: "Prompt not saved"
    });
  };

  // Persist one team's model choice (from either the select or a blurred custom-id text field).
  // Bundles a renormalized reasoning effort into the SAME write whenever the model set changes —
  // see reasoningPatchFor — so a model-only save can never leave (model, effort) invalid.
  const commitProposerModel = (model: string, prev: string) => {
    if (model === (policy.llmModel ?? "")) return; // unchanged from the saved value -> no write
    const patch = {
      llmModel: model,
      ...reasoningPatchFor([model, redTeamModel || model], storedReasoningEffort)
    };
    setLocalProposerModel(model);
    autoSaveModels.save(() => savePolicy(patch).then(() => refresh()), {
      onError: () => setLocalProposerModel(prev),
      errorTitle: "Proposer not saved"
    });
  };
  const commitRedTeamModel = (model: string, prev: string) => {
    if (model === (policy.redTeamLlmModel ?? "")) return; // unchanged from the saved value -> no write
    const patch = {
      // "" (blank = same as proposer) -> null: the policy route strips nulls back to absent,
      // which is how this optional field is actually cleared (an empty string is rejected).
      redTeamLlmModel: model || null,
      ...reasoningPatchFor([proposerModel, model || proposerModel], storedReasoningEffort)
    };
    setLocalRedTeamModel(model);
    autoSaveModels.save(() => savePolicy(patch).then(() => refresh()), {
      onError: () => setLocalRedTeamModel(prev),
      errorTitle: "Reviewer not saved"
    });
  };
  const commitReasoningEffort = (effort: LlmReasoningEffort) => {
    const prev = localReasoningEffort;
    setLocalReasoningEffort(effort);
    autoSaveModels.save(() => savePolicy({ llmReasoningEffort: effort }).then(() => refresh()), {
      onError: () => setLocalReasoningEffort(prev),
      errorTitle: "Reasoning effort not saved"
    });
  };
  // The "Per-model default" blank option: clear the stored effort entirely (the policy route strips
  // the null back to absent), so at call time each model simply runs its own normalization of "no
  // explicit effort" — never a silently-escalated shared high tier.
  const clearReasoningEffort = () => {
    const prev = localReasoningEffort;
    setLocalReasoningEffort("cleared");
    autoSaveModels.save(() => savePolicy({ llmReasoningEffort: null }).then(() => refresh()), {
      onError: () => setLocalReasoningEffort(prev),
      errorTitle: "Reasoning effort not saved"
    });
  };

  // Scoring weights: one factor per blur, skip the write if unchanged from the saved value.
  const commitWeight = (key: keyof ScoringWeights, next: number, saved: number) => {
    if (next === saved) return;
    autoSaveWeights.save(() => savePolicy({ scoringWeights: { [key]: next } }).then(() => refresh()), {
      onError: () => setWeightsOverlay((d) => ({ ...d, [key]: saved }))
    });
  };

  return (
    <div className={`${CONSOLE_PAGE_WIDTH} flex flex-col gap-4`}>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-[length:var(--con-fs-lg)] font-bold">Strategy</h1>
        <Chip tone={reality.tone}>
          {reality.word} · {reality.phrase}
        </Chip>
        <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          for {reality.account?.label ?? "no connected account"} — each account has its own strategy
        </span>
      </div>

      {/* Prompt */}
      <Card title="The strategist's written instructions" action={<SaveStatus status={autoSavePrompt.status} />}>
        <p className="mb-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          Free-text brief the proposer LLM runs under: objective, selection logic, sell rules, sizing guidance, output
          contract. The deterministic policy gate still constrains everything it proposes.
        </p>
        <TextArea
          rows={16}
          value={prompt}
          onChange={(e) => setPromptDraft(e.target.value)}
          onBlur={commitPrompt}
          spellCheck={false}
          title="Saves when you click away."
        />
      </Card>

      {/* Models */}
      <Card title="Models" action={<SaveStatus status={autoSaveModels.status} />}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Proposer" hint="aka Green Team or Bull — writes the trade proposals each run." htmlFor="llm-model">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <ModelSelect
                  id="llm-model"
                  value={proposerModel}
                  role="proposer"
                  disabled={autoSaveModels.saving}
                  onPick={(model) => commitProposerModel(model, proposerModel)}
                  onCustomTextChange={(text) => setLocalProposerModel(text)}
                  onCustomTextBlur={() => {
                    const typed = (localProposerModel ?? "").trim();
                    if (!typed || typed === CUSTOM_MODEL_OPTION) return; // nothing concrete typed
                    commitProposerModel(typed, policy.llmModel ?? "");
                  }}
                />
              </div>
              <ModelStatsButton role="proposer" />
            </div>
          </Field>
          <Field
            label="Reviewer"
            hint="aka Red Team or Bear — reviews every proposal each run, and runs a deeper adversarial debate on high-conviction or dissent-flagged ideas. Blank = same as proposer."
            htmlFor="rt-model"
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <ModelSelect
                  id="rt-model"
                  value={redTeamModel}
                  allowBlank
                  blankLabel="Same As Proposer"
                  role="red-team"
                  disabled={autoSaveModels.saving}
                  onPick={(model) => commitRedTeamModel(model, redTeamModel)}
                  onCustomTextChange={(text) => setLocalRedTeamModel(text)}
                  onCustomTextBlur={() => {
                    const typed = (localRedTeamModel ?? "").trim();
                    if (!typed || typed === CUSTOM_MODEL_OPTION) return; // nothing concrete typed
                    commitRedTeamModel(typed, policy.redTeamLlmModel ?? "");
                  }}
                />
              </div>
              <ModelStatsButton role="red-team" />
            </div>
          </Field>
        </div>
        {showCustomModelWarning && (
          <div className="mt-3 text-xs text-amber-600 bg-amber-50 dark:bg-amber-950/20 dark:text-amber-400 border border-amber-200 dark:border-amber-900/50 rounded-md p-2.5 flex items-start gap-1.5">
            <svg className="h-4 w-4 shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
            </svg>
            <div>
              Custom model selected. Cost tracking will use a conservative fallback rate to prevent budget bypass.
            </div>
          </div>
        )}
        {rotationSelected && (
          <div className="mt-3 rounded-md border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] px-3 py-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
            Rotation: each run picks the next curated model whose provider key resolves (round-robin per account,
            audited). Every proposal records the concrete model that wrote it, so per-model history accrues
            automatically. Intended for paper/test accounts.
          </div>
        )}
        <div className="mt-3 rounded-md border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] px-3 py-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
          Proposer: {modelProviderLabel(proposerModel)}. Reviewer: {modelProviderLabel(effectiveRedTeamModel)}.
          {" "}
          {reasoningSummary(reasoningControl)}
        </div>
        {reasoningControl && (
          <div className="mt-3 max-w-xs">
            <Field
              label={reasoningControl.label}
              hint={
                showPerModelDefaultOption
                  ? `${reasoningControl.hint} “Per-model default” stores no shared effort — at call time each model clamps your account effort to its own supported range and never silently escalates to the slow/expensive high tier. Choosing High enables the high tier on every selected model that supports it.`
                  : reasoningControl.hint
              }
              htmlFor="effort"
            >
              <Select
                id="effort"
                value={reasoningValue ?? ""}
                disabled={autoSaveModels.saving}
                onChange={(e) => {
                  const next = e.target.value;
                  if (!next) {
                    clearReasoningEffort();
                    return;
                  }
                  commitReasoningEffort(next as LlmReasoningEffort);
                }}
              >
                {showPerModelDefaultOption && (
                  <option
                    value=""
                    title="No shared explicit effort — each selected model normalizes the account effort to its own supported range at call time (no silent high-tier escalation)."
                  >
                    Per-model default (no high-tier escalation)
                  </option>
                )}
                {reasoningControl.options.map((option) => (
                  <option key={option.value} value={option.value} title={option.hint}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
            {modelsIgnoringReasoning.length > 0 && (
              <p className="mt-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                {modelsIgnoringReasoning.join(" and ")} takes no reasoning parameters — this setting applies only to the
                other selected model(s).
              </p>
            )}
          </div>
        )}
      </Card>

      {/* Scoring weights */}
      <Card title="Scoring-factor weights" action={<SaveStatus status={autoSaveWeights.status} />}>
        <p className="mb-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          The market scan ranks candidates by these eight factors before the strategist ever sees them. Defaults shown
          under each field. Weights are relative — raising one factor increases its share of the score and lowers the
          others&apos;; only the ratios between factors matter, not the absolute numbers.
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {WEIGHT_KEYS.map((key) => {
            const saved = policy.scoringWeights?.[key] ?? DEFAULT_WEIGHTS[key];
            const current = weightsOverlay[key] ?? saved;
            const meta = FACTOR_META[key] ?? { name: key, tip: "A scoring factor used to rank market-scan candidates." };
            return (
              <Field
                key={key}
                label={
                  <Tooltip content={meta.tip}>
                    <span className="inline-flex cursor-default items-center gap-1">
                      {meta.name}
                      <span aria-hidden className="text-[color:var(--con-faint)]">
                        ⓘ
                      </span>
                      <span className="sr-only">{meta.tip}</span>
                    </span>
                  </Tooltip>
                }
                hint={`default ${DEFAULT_WEIGHTS[key]}`}
                htmlFor={`w-${key}`}
              >
                <RawNumInput
                  id={`w-${key}`}
                  step="0.1"
                  min="0"
                  value={String(current)}
                  emptyValue={DEFAULT_WEIGHTS[key]}
                  title="Saves when you click away."
                  onValueChange={(parsed) => setWeightsOverlay((d) => ({ ...d, [key]: parsed }))}
                  onBlur={() => commitWeight(key, current, saved)}
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
                            toast.push("pos", `Activated “${profile.name}”`, "Applied as the base strategy for new account scope.");
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

function ReviewDirectionTag({ direction }: { direction: ReviewChange["direction"] }) {
  if (direction === "changed") return null;
  const unlocks = direction === "looser";
  const Icon = unlocks ? Unlock : Lock;
  const label = unlocks ? "Unlocks" : "Locks Down";
  const title = unlocks
    ? "Raises a cap, removes a protection, broadens the universe, or otherwise expands trading authority."
    : "Adds a protection, lowers a cap, narrows the universe, or otherwise restricts trading authority.";
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-current px-1.5 py-0.5 text-[length:var(--con-fs-xs)] font-bold"
      style={{ color: unlocks ? "var(--con-warn)" : "var(--con-pos)" }}
      title={title}
    >
      <Icon size={12} aria-hidden />
      {label}
    </span>
  );
}

/** Flatten the tune proposal's policy/weights patch into labeled from→to rows,
 *  classified LOOSER/TIGHTER via the same guardrail metadata the Guardrails
 *  editor uses — so brokerage loosening costs the same typed word here too. */
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
  const [reviewReasoning, setReviewReasoning] = useState<LlmReasoningEffort | undefined>(undefined);
  const [busy, setBusy] = useState<"review" | "apply" | null>(null);
  const [review, setReview] = useState<StrategyTuneResult | null>(null);
  const [typed, setTyped] = useState("");
  useUnsavedChanges(review !== null);

  // The rotation sentinel is not a callable model — when a rotating seat would be inherited,
  // fall through to the next concrete choice (AI review runs once, outside the per-run rotation).
  const inheritedReviewerModel =
    [policy.redTeamLlmModel, policy.llmModel].find((m) => m && m !== ROTATE_ALL_MODELS_ID) || "";
  const inheritedReviewerLabel =
    policy.redTeamLlmModel && policy.redTeamLlmModel !== ROTATE_ALL_MODELS_ID ? "Reviewer" : "Proposer";
  // With EVERY team seat rotating there is no concrete model to inherit; a blank pick then honestly
  // degrades server-side to local rules (no LLM) — disclose that upfront instead of only via the
  // after-the-fact "local rules" chip (see policyForTuningReviewer in src/lib/strategy-tuning.ts).
  const rotationBlocksInheritance =
    !inheritedReviewerModel && [policy.redTeamLlmModel, policy.llmModel].some((m) => m === ROTATE_ALL_MODELS_ID);
  const reviewerModel = model || inheritedReviewerModel;
  const reviewerReasoningControl = reasoningControlForModels([reviewerModel]);
  const reviewerReasoningValue = reviewerReasoningControl
    ? normalizeReasoningValueForControl([reviewerModel], reviewerReasoningControl, reviewReasoning ?? policy.llmReasoningEffort)
    : undefined;
  const changes = useMemo(() => (review ? reviewChanges(review.proposedPatch, policy) : []), [review, policy]);
  const promptChanged = Boolean(review?.proposedPatch.prompt && review.proposedPatch.prompt !== strategyPrompt);
  const hasAnyChange = changes.length > 0 || promptChanged;
  const hasLooser = changes.some((c) => c.direction === "looser");
  const needsTyped = reality.tone === "live" && hasLooser && policy.requireTypedConfirmation !== false;

  const generate = async () => {
    setBusy("review");
    try {
      const result = await tuneStrategy(model || undefined, reviewerReasoningValue);
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
        A strategist model reads this account&apos;s recent performance, missed opportunities, factor evidence, and the
        market backdrop, then proposes prompt/weight/guardrail changes. Nothing is applied until you review the exact
        diff and commit it — the same rules as editing by hand, including a typed word for LIVE authority expansion.
      </p>

      {!review ? (
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-64">
            <Field
              label="Strategist"
              hint={
                rotationBlocksInheritance
                  ? "Both team seats rotate, so there is no single model to inherit. Pick a strategist model here — left blank, the review runs on local rules (no LLM)."
                  : `Blank = same as ${inheritedReviewerLabel}. AI Review has no separate account-level model.`
              }
              htmlFor="ai-review-model"
            >
              <Select id="ai-review-model" value={model} onChange={(e) => { setModel(e.target.value); setReviewReasoning(undefined); }}>
                <option value="">
                  {rotationBlocksInheritance ? "No model — local rules (no LLM)" : `Same As ${inheritedReviewerLabel}`}
                </option>
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
          {reviewerReasoningControl && reviewerReasoningValue && (
            <div className="w-56">
              <Field label={reviewerReasoningControl.label} hint={reviewerReasoningControl.hint} htmlFor="ai-review-effort">
                <Select
                  id="ai-review-effort"
                  value={reviewerReasoningValue}
                  onChange={(e) => setReviewReasoning(e.target.value as LlmReasoningEffort)}
                >
                  {reviewerReasoningControl.options.map((option) => (
                    <option key={option.value} value={option.value} title={option.hint}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )}
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
                      <ReviewDirectionTag direction={c.direction} />
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
                note="At least one proposed change expands authority on a brokerage account. Unlocking authority costs a typed word here exactly like it does in Guardrails."
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
