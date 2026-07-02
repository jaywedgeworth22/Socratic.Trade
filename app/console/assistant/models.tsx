/** Chat-model catalog for the console assistant's native grouped <select>.
 *
 *  Model ids MUST match what POST /api/chat routes on (see chatProviderForModel
 *  in src/lib/chat/llm.ts: claude-* -> anthropic, grok-* -> xai, gemini-* ->
 *  gemini, mistral-family -> mistral, deepseek-* -> deepseek, else openai).
 *  This mirrors the curated list in app/ui/llm-model-catalog.ts; it is kept
 *  local because the console deliberately imports nothing from app/ui/*.
 *  Follow-up: fold into app/console/lib/models once that shared module lands.
 */

export interface ModelOption {
  value: string;
  label: string;
  /** Relative blended cost within the provider ("" for keyless/offline). */
  tier: "" | "$" | "$$" | "$$$";
}

export interface ModelGroup {
  /** Internal provider id, matching GET /api/chat/providers keys ("offline" is local-only). */
  provider: "offline" | "openai" | "anthropic" | "xai" | "gemini" | "mistral" | "deepseek";
  label: string;
  options: ModelOption[];
}

export const DEFAULT_CHAT_MODEL = "gpt-5.4-mini";

/** Sentinel select value meaning "type a model id yourself". */
export const CUSTOM_MODEL_VALUE = "custom";

export const MODEL_GROUPS: ModelGroup[] = [
  {
    provider: "offline",
    label: "Offline",
    options: [
      { value: "mock", label: "Mock — deterministic, no key", tier: "" },
      { value: CUSTOM_MODEL_VALUE, label: "Custom model id…", tier: "" }
    ]
  },
  {
    provider: "openai",
    label: "OpenAI",
    options: [
      { value: "gpt-5.4-nano", label: "gpt-5.4-nano — lowest cost OpenAI", tier: "$" },
      { value: "gpt-5.4-mini", label: "gpt-5.4-mini — balanced default", tier: "$$" },
      { value: "gpt-5.4", label: "gpt-5.4 — stronger analysis", tier: "$$$" },
      { value: "gpt-5.5", label: "gpt-5.5 — deepest OpenAI reasoning", tier: "$$$" }
    ]
  },
  {
    provider: "anthropic",
    label: "Anthropic (Claude)",
    options: [
      { value: "claude-haiku-4-5", label: "claude-haiku-4-5 — fast Claude review", tier: "$" },
      { value: "claude-sonnet-4-6", label: "claude-sonnet-4-6 — balanced Claude analysis", tier: "$$" },
      { value: "claude-opus-4-8", label: "claude-opus-4-8 — premium Claude critique", tier: "$$$" },
      { value: "claude-fable-5", label: "claude-fable-5 — most capable Claude", tier: "$$$" }
    ]
  },
  {
    provider: "xai",
    label: "xAI (Grok)",
    options: [
      { value: "grok-build-0.1", label: "grok-build-0.1 — lowest cost Grok", tier: "$" },
      { value: "grok-4.3", label: "grok-4.3 — stronger Grok analysis", tier: "$$" }
    ]
  },
  {
    provider: "gemini",
    label: "Google Gemini",
    options: [
      { value: "gemini-2.5-flash-lite", label: "gemini-2.5-flash-lite — lowest cost Gemini", tier: "$" },
      { value: "gemini-2.5-flash", label: "gemini-2.5-flash — fast long-context review", tier: "$" },
      { value: "gemini-2.5-pro", label: "gemini-2.5-pro — stronger Gemini reasoning", tier: "$$" },
      { value: "gemini-3.1-flash-lite", label: "gemini-3.1-flash-lite — latest light Gemini", tier: "$" },
      { value: "gemini-3.5-flash", label: "gemini-3.5-flash — latest Flash tier", tier: "$$" }
    ]
  },
  {
    provider: "mistral",
    label: "Mistral",
    options: [
      { value: "mistral-small-2506", label: "mistral-small-2506 — low-cost Mistral", tier: "$" },
      { value: "mistral-medium-3-5", label: "mistral-medium-3-5 — current balanced Mistral", tier: "$$" },
      { value: "mistral-large-2512", label: "mistral-large-2512 — strongest Mistral", tier: "$$$" }
    ]
  },
  {
    provider: "deepseek",
    label: "DeepSeek",
    options: [
      { value: "deepseek-v4-flash", label: "deepseek-v4-flash — fast DeepSeek V4", tier: "$" },
      { value: "deepseek-v4-pro", label: "deepseek-v4-pro — stronger DeepSeek V4", tier: "$$" }
    ]
  }
];

export const CATALOG_MODEL_IDS = new Set(MODEL_GROUPS.flatMap((g) => g.options.map((o) => o.value)));

/** Client-side mirror of the server's chatProviderForModel, so the UI can warn
 *  about a missing key for THE provider this exact request would hit ("mock"
 *  is the explicit keyless path). */
export function providerForModel(model: string): "mock" | "openai" | "anthropic" | "xai" | "gemini" | "mistral" | "deepseek" {
  const m = model.trim().toLowerCase();
  if (m === "mock") return "mock";
  if (/^claude/.test(m)) return "anthropic";
  if (/^grok/.test(m)) return "xai";
  if (/^gemini/.test(m)) return "gemini";
  if (/^(mistral|ministral|magistral|codestral|devstral|pixtral|open-mistral|open-mixtral)/.test(m)) return "mistral";
  if (/^deepseek/.test(m)) return "deepseek";
  return "openai";
}

export function providerDisplayName(provider: string): string {
  switch (provider) {
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "xai":
      return "xAI (Grok)";
    case "gemini":
      return "Google Gemini";
    case "mistral":
      return "Mistral";
    case "deepseek":
      return "DeepSeek";
    default:
      return provider;
  }
}
