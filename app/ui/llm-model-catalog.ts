// Model catalog shape. These types formerly lived in app/ui/model-picker.tsx; that custom
// dropdown component was retired 2026-07-17 (zero importers — the console assistant uses its own
// picker), so the still-used type surface moved here, the catalog's own home.
export type PickerProviderId =
  | "openai"
  | "anthropic"
  | "xai"
  | "gemini"
  | "mistral"
  | "deepseek"
  | "meta"
  | "moonshot"
  | "openrouter"
  | "offline";

export interface ModelOption {
  value: string;
  label: string;
  tier: "" | "$" | "$$" | "$$$";
  recommendedGreen?: boolean;
  recommendedRed?: boolean;
}

export interface ModelGroup {
  provider: PickerProviderId;
  label: string;
  options: ModelOption[];
}

export const CUSTOM_MODEL_ID_SEED = "custom-model-id";

/**
 * Sentinel model id meaning "rotate through all eligible curated models — a different one each
 * run" (comparative-measurement option for accruing attributed history across models on any real
 * broker account). Persisted as-is on policy.llmModel / policy.redTeamLlmModel; the strategy
 * run substitutes the concrete round-robin pick at run start (src/lib/model-rotation.ts — models
 * with no resolvable provider key are skipped). Keep the literal in sync with
 * LLM_MODEL_ROTATION_SENTINEL in src/lib/llm-request.ts.
 */
export const ROTATE_ALL_MODELS_ID = "__rotate__";
export const ROTATE_ALL_MODELS_LABEL = "Rotate eligible models (comparative measurement)";

export const CURATED_LLM_MODEL_GROUPS: ModelGroup[] = [
  {
    provider: "openai",
    label: "OpenAI",
    options: [
      { value: "gpt-5.4-nano", label: "gpt-nano-latest - lowest cost OpenAI", tier: "$" },
      { value: "gpt-5.4-mini", label: "gpt-mini-latest - proven low-cost OpenAI", tier: "$$" },
      { value: "gpt-5.6-luna", label: "gpt-luna-latest - current cost-sensitive tier", tier: "$$" },
      { value: "gpt-5.6-terra", label: "gpt-terra-latest - balanced current-generation analysis", tier: "$$$", recommendedGreen: true },
      { value: "gpt-5.6-sol", label: "gpt-sol-latest - frontier professional reasoning", tier: "$$$", recommendedRed: true },
      { value: "gpt-4o", label: "gpt-4o-latest - flagship OpenAI GPT-4o", tier: "$$$" }
    ]
  },
  {
    provider: "anthropic",
    label: "Anthropic",
    options: [
      { value: "claude-haiku-4.5", label: "claude-haiku-latest - fast low-cost Claude", tier: "$", recommendedGreen: true },
      { value: "claude-sonnet-5", label: "claude-sonnet-latest - balanced Claude analysis", tier: "$$", recommendedRed: true },
      { value: "claude-opus-5", label: "claude-opus-latest (5) - premium Claude reasoning", tier: "$$$" },
      { value: "claude-fable-5", label: "claude-fable-latest - most capable Claude", tier: "$$$" }
    ]
  },
  {
    provider: "xai",
    label: "xAI",
    options: [
      { value: "grok-build-0.1", label: "grok-build-0.1 - coding specialist", tier: "$" },
      { value: "grok-4.5", label: "grok-latest - default Grok analysis", tier: "$$" }
    ]
  },
  {
    provider: "gemini",
    label: "Google",
    options: [
      { value: "gemini-flash-lite-latest", label: "gemini-3.5-flash-lite - low-cost Gemini", tier: "$" },
      { value: "gemini-flash-latest", label: "gemini-flash-latest - stable flagship Flash", tier: "$$", recommendedGreen: true },
      { value: "gemini-pro-latest", label: "gemini-pro-latest - deepest Gemini reasoning", tier: "$$$", recommendedRed: true }
    ]
  },
  {
    provider: "mistral",
    label: "Mistral",
    options: [
      { value: "mistral-small-latest", label: "mistral-small-2603 - low-cost Mistral Small", tier: "$" },
      { value: "mistral-medium-latest", label: "mistral-medium-3.5 - frontier Mistral Medium", tier: "$$" }
    ]
  },
  {
    provider: "moonshot",
    label: "Moonshot AI (Kimi)",
    options: [
      { value: "kimi-latest", label: "kimi-latest (k3) - Kimi frontier model", tier: "$$" }
    ]
  },
  {
    provider: "deepseek",
    label: "DeepSeek",
    options: [
      { value: "deepseek-v4-flash", label: "deepseek-flash-latest - fast DeepSeek Flash", tier: "$" },
      { value: "deepseek-v4-pro", label: "deepseek-pro-latest - stronger DeepSeek Pro", tier: "$$" },
      { value: "deepseek-reasoner", label: "deepseek-r1-latest - reasoning DeepSeek R1", tier: "$$$" }
    ]
  },
  {
    provider: "meta",
    label: "Meta",
    options: [
      { value: "llama-3.3-70b-instruct", label: "llama-3.3-70b-instruct - flagship open-weights analysis", tier: "$$" }
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
