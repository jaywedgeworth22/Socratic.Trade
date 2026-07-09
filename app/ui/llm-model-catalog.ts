import type { ModelGroup } from "./model-picker";

export const DEFAULT_LLM_MODEL = "gpt-5.4-mini";
export const CUSTOM_MODEL_ID_SEED = "custom-model-id";

// Label + recommendation conventions (owner rulings 2026-07-08; keep in sync with
// app/console/settings/models.tsx): descriptors are ROLE-NEUTRAL noun phrases (this catalog feeds
// both the Green/proposer and Red/reviewer pickers — no "critique"/"review" in a label).
// Recommendations are EMPIRICAL — derived from THIS ACCOUNT's call history (llm_step outcomes +
// llm_usage), never from model naming/marketing or per-provider quotas. Snapshot 2026-07-08
// (excluding the fixed Gemini bear format incident and the fixed pre-#1036 60s-timeout class):
// gemini-3.5-flash bear 46/46 post-fix + bull 27/0; gpt-5.4-mini bull 22/2 + bear 18/1;
// deepseek-v4-pro bear 17/3 (fixed timeout class) but no successful Green history. Zero-history
// models carry no rec until they earn one (claude-sonnet-5, gemini-3.1-pro-preview). Key-level
// quota/rate limits (e.g. the 2026-07 Anthropic usage cap, the OpenAI rate-limit failures in
// gpt-5.5's bull record) are OWNER-ADJUSTABLE account settings, NOT model qualities — never hold
// them against a model here; they only mean the history is thin/noisy until the owner raises the
// limit and real calls accrue. Re-derive the flags from history as it accrues.
export const CURATED_LLM_MODEL_GROUPS: ModelGroup[] = [
  {
    provider: "openai",
    label: "OpenAI",
    options: [
      { value: "gpt-5.4-nano", label: "gpt-5.4-nano - lowest cost OpenAI", tier: "$" },
      { value: "gpt-5.4-mini", label: "gpt-5.4-mini - balanced default", tier: "$$", recommendedGreen: true, recommendedRed: true },
      { value: "gpt-5.4", label: "gpt-5.4 - stronger analysis", tier: "$$$" },
      { value: "gpt-5.5", label: "gpt-5.5 - deepest OpenAI reasoning", tier: "$$$" }
    ]
  },
  {
    provider: "anthropic",
    label: "Anthropic (Claude)",
    options: [
      { value: "claude-haiku-4-5", label: "claude-haiku-4-5 - fast low-cost Claude", tier: "$" },
      { value: "claude-sonnet-5", label: "claude-sonnet-5 - balanced Claude analysis", tier: "$$" },
      { value: "claude-opus-4-8", label: "claude-opus-4-8 - premium Claude reasoning", tier: "$$$" },
      { value: "claude-fable-5", label: "claude-fable-5 - most capable Claude", tier: "$$$" }
    ]
  },
  {
    provider: "xai",
    label: "xAI (Grok)",
    options: [
      { value: "grok-build-0.1", label: "grok-build-0.1 - coding specialist", tier: "$" },
      { value: "grok-4.3", label: "grok-4.3 - default Grok analysis", tier: "$$" }
    ]
  },
  {
    provider: "gemini",
    label: "Google (Gemini)",
    options: [
      { value: "gemini-3.1-flash-lite", label: "gemini-3.1-flash-lite - low-cost Gemini", tier: "$" },
      { value: "gemini-3.5-flash", label: "gemini-3.5-flash - stable flagship Flash", tier: "$$", recommendedGreen: true, recommendedRed: true },
      { value: "gemini-3.1-pro-preview", label: "gemini-3.1-pro-preview - deepest Gemini reasoning", tier: "$$$" }
    ]
  },
  {
    provider: "mistral",
    label: "Mistral",
    options: [
      { value: "mistral-small-2603", label: "mistral-small-2603 - low-cost Mistral Small 4", tier: "$" },
      { value: "mistral-medium-3-5", label: "mistral-medium-3-5 - frontier Mistral Medium", tier: "$$" }
    ]
  },
  {
    provider: "deepseek",
    label: "DeepSeek",
    options: [
      { value: "deepseek-v4-flash", label: "deepseek-v4-flash - fast DeepSeek V4", tier: "$" },
      { value: "deepseek-v4-pro", label: "deepseek-v4-pro - stronger DeepSeek V4", tier: "$$", recommendedRed: true }
    ]
  }
];

export const CURATED_LLM_MODEL_IDS = CURATED_LLM_MODEL_GROUPS.flatMap((group) => group.options.map((option) => option.value));

export const CHAT_MODEL_GROUPS: ModelGroup[] = [
  {
    provider: "offline",
    label: "Offline",
    options: [
      { value: "mock", label: "Mock - deterministic, no key", tier: "" },
      { value: "custom", label: "Custom Model ID...", tier: "" }
    ]
  },
  ...CURATED_LLM_MODEL_GROUPS
];
