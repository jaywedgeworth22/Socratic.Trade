/** Model → provider attribution for the console. Pure module (no imports from
 *  app/ui): the provider regex mirrors `providerForModel` in
 *  src/lib/usage-budget.ts / resolveLlmEndpoint's prefix logic, and the curated
 *  display names mirror app/ui/llm-model-catalog.ts. Keep the three in sync when
 *  adding a provider family.
 *
 *  Universal OpenRouter routing (PR #1703) means a model recorded/selected as e.g.
 *  "claude-sonnet-5" can now show up (in decisions, usage, everywhere a raw model id is read
 *  back) vendor-qualified as "anthropic/claude-sonnet-5", "x-ai/grok-4.3", "google/gemini-2.5-
 *  flash", etc. — see resolveLlmEndpoint in src/lib/llm-provider.ts for the exact prefixes.
 *  `bareModelId` strips that routing prefix before any provider/display lookup runs, reusing
 *  the SHARED canonicalizer (src/lib/model-identity.ts, consolidated in #1736 from the
 *  model-identity work in #1703/#1716) rather than re-deriving the stripping logic here. */

import { canonicalModelId as bareModelId } from "@/lib/model-identity";

export type ConsoleProviderId = "openai" | "anthropic" | "xai" | "gemini" | "mistral" | "deepseek" | "meta" | "moonshot";

// DEFAULT_GREEN_MODEL_ID was removed 2026-07-07 (owner directive: no model default for anything,
// ever). There is no server default when policy.llmModel is unset — the run fails closed until a
// model is explicitly chosen, so the console must never display a made-up default as if it served.

/** Provider a model id routes to. Unknown/custom ids fall through to OpenAI —
 *  the same behavior as the server-side endpoint resolution. Strips any OpenRouter
 *  vendor-routing prefix first, so "x-ai/grok-4.3" and "google/gemini-2.5-flash" brand as xAI
 *  and Google — not OpenAI — the same as their bare, pre-routing ids always did. */
export function providerForModel(modelId: string | null | undefined): ConsoleProviderId {
  const m = bareModelId(modelId).toLowerCase();
  if (/^(claude|anthropic)/.test(m)) return "anthropic";
  if (/^grok/.test(m)) return "xai";
  if (/^gemini/.test(m)) return "gemini";
  if (/(mistral|ministral|magistral|codestral|devstral|pixtral|open-mistral|open-mixtral)/.test(m)) return "mistral";
  if (/^deepseek/.test(m)) return "deepseek";
  if (/^llama/.test(m)) return "meta";
  if (/(kimi|moonshot)/.test(m)) return "moonshot";
  return "openai";
}

/** True when the raw id carries an OpenRouter vendor-routing prefix — either the transparent
 *  universal-routing shape ("anthropic/claude-sonnet-5") or an explicit legacy override
 *  ("openrouter/anthropic/claude-3.5-sonnet"). Bare native/custom ids never contain "/", so this
 *  is exact, not a heuristic. Lets callers show "via OpenRouter" as a separate transport signal
 *  instead of folding it into the vendor brand or the display name. */
export function isOpenRouterRouted(modelId: string | null | undefined): boolean {
  return (modelId ?? "").includes("/");
}

const PROVIDER_LABEL: Record<ConsoleProviderId, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic (Claude)",
  xai: "xAI (Grok)",
  gemini: "Google (Gemini)",
  mistral: "Mistral",
  deepseek: "DeepSeek",
  meta: "Meta (Llama)",
  moonshot: "Moonshot AI (Kimi)"
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
  meta: { initial: "L", color: "#0467df" },
  moonshot: { initial: "K", color: "#6b21a8" }
};

/** Curated model ids the picker offers (mirrors CURATED_LLM_MODEL_GROUPS in
 *  app/ui/llm-model-catalog.ts). Only used for display names — an id that's
 *  missing here still renders (as its raw id) via modelDisplayName. */
const MODEL_DISPLAY_NAME: Record<string, string> = {
  // OpenAI
  "gpt-5.4-nano": "GPT Nano Latest",
  "gpt-5.4-mini": "GPT Mini Latest",
  "gpt-5.6-luna": "GPT Luna Latest",
  "gpt-5.6-terra": "GPT Terra Latest",
  "gpt-5.6-sol": "GPT Sol Latest",
  "gpt-4o": "GPT-4o Latest",
  "gpt-5.4": "GPT-5.4",
  "gpt-5.5": "GPT-5.5",
  "gpt-5.6": "GPT-5.6 Sol",
  "gpt-4o-mini": "GPT-4o mini",
  // Anthropic
  "claude-haiku-4.5": "Claude Haiku Latest",
  "claude-sonnet-5": "Claude Sonnet Latest",
  "claude-opus-5": "Claude Opus Latest (5)",
  "claude-fable-5": "Claude Fable Latest",
  "claude-haiku-4-5": "Claude Haiku 4.5",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-opus-4-8": "Claude Opus 4.8",
  // xAI
  "grok-build-latest": "Grok Build Latest",
  "grok-4.5": "Grok Latest",
  "grok-build-0.1": "Grok Build 0.1",
  "grok-4.3": "Grok 4.3",
  // Google (Gemini)
  "gemini-flash-lite-latest": "Gemini Flash-Lite Latest",
  "gemini-flash-latest": "Gemini Flash Latest",
  "gemini-pro-latest": "Gemini Pro Latest",
  "gemini-2.5-flash-lite": "Gemini 2.5 Flash-Lite",
  "gemini-2.5-flash": "Gemini 2.5 Flash",
  "gemini-2.5-pro": "Gemini 2.5 Pro",
  "gemini-3.1-flash-lite": "Gemini 3.1 Flash-Lite",
  "gemini-3.5-flash": "Gemini 3.5 Flash",
  "gemini-3.1-pro-preview": "Gemini 3.1 Pro Preview",
  // Mistral
  "mistral-small-latest": "Mistral Small Latest",
  "mistral-medium-latest": "Mistral Medium Latest",
  "mistral-small-2506": "Mistral Small 2506",
  "mistral-medium-3-5": "Mistral Medium 3.5",
  "mistral-large-2512": "Mistral Large 2512",
  // DeepSeek
  "deepseek-v4-flash": "DeepSeek Flash Latest",
  "deepseek-v4-pro": "DeepSeek Pro Latest",
  "deepseek-reasoner": "DeepSeek R1 Latest",
  "deepseek-r1": "DeepSeek R1",
  "deepseek-chat": "DeepSeek Chat",
  // Moonshot AI
  "kimi-latest": "Kimi Latest (k3)",
  "kimi-k3": "Kimi k3",
  "llama-70b-latest": "Llama 70B Latest",
  "llama-3.3-70b-instruct": "Llama 3.3 70B"
};

/** Human display name for a model id; falls back to the bare id (OpenRouter vendor-routing
 *  prefix stripped, so a curated model routed through OpenRouter still shows "Grok 4.3" instead
 *  of the raw "x-ai/grok-4.3") when it isn't in the curated catalog, so custom ids still render
 *  honestly. */
export function modelDisplayName(modelId: string | null | undefined): string {
  const id = (modelId ?? "").trim();
  if (!id) return "";
  const bare = bareModelId(id);
  return MODEL_DISPLAY_NAME[bare] ?? bare;
}
