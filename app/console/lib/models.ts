/** Model → provider attribution for the console. Pure module (no imports from
 *  app/ui): the provider regex mirrors `providerForModel` in
 *  src/lib/usage-budget.ts / resolveLlmEndpoint's prefix logic, and the curated
 *  display names mirror app/ui/llm-model-catalog.ts. Keep the three in sync when
 *  adding a provider family. */

export type ConsoleProviderId = "openai" | "anthropic" | "xai" | "gemini" | "mistral" | "deepseek" | "openrouter";

// DEFAULT_GREEN_MODEL_ID was removed 2026-07-07 (owner directive: no model default for anything,
// ever). There is no server default when policy.llmModel is unset — the run fails closed until a
// model is explicitly chosen, so the console must never display a made-up default as if it served.

/** Provider a model id routes to. Unknown/custom ids fall through to OpenAI —
 *  the same behavior as the server-side endpoint resolution. */
export function providerForModel(modelId: string | null | undefined): ConsoleProviderId {
  const raw = (modelId ?? "").trim().toLowerCase();
  let m = raw;
  
  if (m.startsWith("openrouter/")) {
    const parts = m.split("/");
    if (parts.length >= 3) {
      m = parts[1]; // Use vendor namespace for matching
    } else {
      return "openrouter";
    }
  }

  if (/^(claude|anthropic)/.test(m)) return "anthropic";
  if (/^grok/.test(m) || m === "x-ai" || m === "xai") return "xai";
  if (/^gemini/.test(m) || m === "google") return "gemini";
  if (/^(mistral|ministral|magistral|codestral|devstral|pixtral|open-mistral|open-mixtral)/.test(m) || m === "mistralai") return "mistral";
  if (/^deepseek/.test(m)) return "deepseek";
  if (raw.startsWith("openrouter/")) return "openrouter";
  return "openai";
}

const PROVIDER_LABEL: Record<ConsoleProviderId, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic (Claude)",
  xai: "xAI (Grok)",
  gemini: "Google (Gemini)",
  mistral: "Mistral",
  deepseek: "DeepSeek",
  openrouter: "OpenRouter"
};

export function providerLabel(provider: ConsoleProviderId): string {
  return PROVIDER_LABEL[provider];
}

/** Tile fallback (colored initial) when /model-logos/<provider>.svg fails to load. */
export const PROVIDER_META: Record<ConsoleProviderId, { initial: string; color: string }> = {
  openai: { initial: "O", color: "#10a37f" },
  anthropic: { initial: "C", color: "#d97757" },
  xai: { initial: "x", color: "#111827" },
  gemini: { initial: "G", color: "#1a73e8" },
  mistral: { initial: "M", color: "#fa520f" },
  deepseek: { initial: "D", color: "#4d6bfe" },
  openrouter: { initial: "OR", color: "#161b22" }
};

/** Curated model ids the picker offers (mirrors CURATED_LLM_MODEL_GROUPS in
 *  app/ui/llm-model-catalog.ts). Only used for display names — an id that's
 *  missing here still renders (as its raw id) via modelDisplayName. */
const MODEL_DISPLAY_NAME: Record<string, string> = {
  // OpenAI
  "gpt-5.4-nano": "GPT-5.4 nano",
  "gpt-5.4-mini": "GPT-5.4 mini",
  "gpt-5.4": "GPT-5.4",
  "gpt-5.5": "GPT-5.5",
  "gpt-5.6": "GPT-5.6 Sol",
  "gpt-5.6-luna": "GPT-5.6 Luna",
  "gpt-5.6-terra": "GPT-5.6 Terra",
  "gpt-5.6-sol": "GPT-5.6 Sol",
  "openrouter/openai/gpt-5.4-nano": "GPT-5.4 nano",
  "openrouter/openai/gpt-5.4-mini": "GPT-5.4 mini",
  "openrouter/openai/gpt-5.6-luna": "GPT-5.6 Luna",
  "openrouter/openai/gpt-5.6-luna-pro": "GPT-5.6 Luna Pro",
  "openrouter/openai/gpt-5.6-terra": "GPT-5.6 Terra",
  "openrouter/openai/gpt-5.6-terra-pro": "GPT-5.6 Terra Pro",
  "openrouter/openai/gpt-5.6-sol": "GPT-5.6 Sol",
  "openrouter/openai/gpt-5.6-sol-pro": "GPT-5.6 Sol Pro",
  
  // Anthropic
  "claude-haiku-4-5": "Claude Haiku 4.5",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-opus-4-8": "Claude Opus 4.8",
  "claude-fable-5": "Claude Fable 5",
  "openrouter/anthropic/claude-haiku-4.5": "Claude Haiku 4.5",
  "openrouter/anthropic/claude-sonnet-5": "Claude Sonnet 5",
  "openrouter/anthropic/claude-opus-4.8": "Claude Opus 4.8",
  "openrouter/anthropic/claude-fable-5": "Claude Fable 5",
  
  // xAI
  "grok-build-0.1": "Grok Build 0.1",
  "grok-4.3": "Grok 4.3",
  "openrouter/x-ai/grok-build-0.1": "Grok Build 0.1",
  "openrouter/x-ai/grok-4.3": "Grok 4.3",
  
  // Google (Gemini)
  "gemini-2.5-flash-lite": "Gemini 2.5 Flash-Lite",
  "gemini-2.5-flash": "Gemini 2.5 Flash",
  "gemini-2.5-pro": "Gemini 2.5 Pro",
  "gemini-3.1-flash-lite": "Gemini 3.1 Flash-Lite",
  "gemini-3.5-flash": "Gemini 3.5 Flash",
  "gemini-3.1-pro-preview": "Gemini 3.1 Pro Preview",
  "openrouter/google/gemini-3.1-flash-lite": "Gemini 3.1 Flash-Lite",
  "openrouter/google/gemini-3.5-flash": "Gemini 3.5 Flash",
  "openrouter/google/gemini-3.1-pro-preview": "Gemini 3.1 Pro Preview",
  
  // Mistral
  "mistral-small-2506": "Mistral Small 2506",
  "mistral-small-2603": "Mistral Small 2603",
  "mistral-medium-3-5": "Mistral Medium 3.5",
  "mistral-large-2512": "Mistral Large 2512",
  "openrouter/mistralai/mistral-small-2603": "Mistral Small 2603",
  "openrouter/mistralai/mistral-medium-3-5": "Mistral Medium 3.5",
  
  // DeepSeek
  "deepseek-v4-flash": "DeepSeek V4 Flash",
  "deepseek-v4-pro": "DeepSeek V4 Pro",
  "deepseek-chat": "DeepSeek Chat",
  "deepseek-reasoner": "DeepSeek Reasoner",
  "openrouter/deepseek/deepseek-v4-flash": "DeepSeek V4 Flash",
  "openrouter/deepseek/deepseek-v4-pro": "DeepSeek V4 Pro"
};

/** Human display name for a model id; falls back to the raw id (trimmed) when
 *  it isn't in the curated catalog, so custom ids still render honestly. */
export function modelDisplayName(modelId: string | null | undefined): string {
  const id = (modelId ?? "").trim();
  if (!id) return "";
  return MODEL_DISPLAY_NAME[id] ?? id;
}
