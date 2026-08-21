/**
 * Canonical three-column LLM catalog (owner 2026-08-21).
 *
 * 1. displaySlug — persisted / UI / settings / logs / picker
 * 2. openRouterSlug — OpenRouter chat/completions `model` on live calls
 * 3. nativeSlug — direct provider APIs (not used for live traffic today)
 *
 * Parentheticals in owner copy (e.g. "gpt-mini-latest (5.4)") are version hints
 * only.  They are never stored.
 */

export type CatalogProviderId =
  | "openai"
  | "anthropic"
  | "xai"
  | "gemini"
  | "mistral"
  | "deepseek"
  | "meta"
  | "moonshot";

export type CatalogTier = "" | "$" | "$$" | "$$$";

export interface LlmCatalogEntry {
  displaySlug: string;
  openRouterSlug: string;
  nativeSlug: string;
  provider: CatalogProviderId;
  label: string;
  tier: CatalogTier;
  recommendedGreen?: boolean;
  recommendedRed?: boolean;
  /** Older persisted / OpenRouter / native ids that must resolve to this row. */
  aliases: readonly string[];
}

export const LLM_MODEL_CATALOG: readonly LlmCatalogEntry[] = [
  {
    displaySlug: "gpt-5.4-nano",
    openRouterSlug: "openai/gpt-5.4-nano",
    nativeSlug: "gpt-5.4-nano",
    provider: "openai",
    label: "gpt-5.4-nano — lowest cost OpenAI",
    tier: "$",
    aliases: ["gpt-nano-latest", "openai/gpt-5.4-nano", "openai/gpt-nano-latest"]
  },
  {
    displaySlug: "gpt-mini-latest",
    openRouterSlug: "~openai/gpt-mini-latest",
    nativeSlug: "gpt-5.4-mini",
    provider: "openai",
    label: "gpt-mini-latest (5.4) — proven low-cost OpenAI",
    tier: "$$",
    aliases: ["gpt-5.4-mini", "openai/gpt-mini-latest", "openai/gpt-5.4-mini"]
  },
  {
    displaySlug: "gpt-5.6-luna",
    openRouterSlug: "openai/gpt-5.6-luna",
    nativeSlug: "gpt-5.6-luna",
    provider: "openai",
    label: "gpt-5.6-luna — current cost-sensitive tier",
    tier: "$$",
    aliases: ["gpt-luna-latest", "openai/gpt-5.6-luna"]
  },
  {
    displaySlug: "gpt-5.6-terra",
    openRouterSlug: "openai/gpt-5.6-terra",
    nativeSlug: "gpt-5.6-terra",
    provider: "openai",
    label: "gpt-5.6-terra — balanced current-generation analysis",
    tier: "$$$",
    recommendedGreen: true,
    aliases: ["gpt-terra-latest", "openai/gpt-5.6-terra"]
  },
  {
    displaySlug: "gpt-5.6-sol",
    openRouterSlug: "openai/gpt-5.6-sol",
    nativeSlug: "gpt-5.6-sol",
    provider: "openai",
    label: "gpt-5.6-sol — frontier professional reasoning",
    tier: "$$$",
    recommendedRed: true,
    aliases: ["gpt-sol-latest", "openai/gpt-5.6-sol", "gpt-5.6"]
  },
  {
    displaySlug: "gpt-4o",
    openRouterSlug: "openai/gpt-4o",
    nativeSlug: "gpt-4o",
    provider: "openai",
    label: "gpt-4o — flagship OpenAI GPT-4o",
    tier: "$$$",
    aliases: ["gpt-4o-latest", "openai/gpt-4o"]
  },
  {
    displaySlug: "gpt-4o-mini",
    openRouterSlug: "openai/gpt-4o-mini",
    nativeSlug: "gpt-4o-mini",
    provider: "openai",
    label: "gpt-4o-mini — small GPT-4o",
    tier: "$$",
    aliases: ["openai/gpt-4o-mini"]
  },
  {
    displaySlug: "claude-haiku-latest",
    openRouterSlug: "~anthropic/claude-haiku-latest",
    nativeSlug: "claude-haiku-4.5",
    provider: "anthropic",
    label: "claude-haiku-latest (4.5) — fast low-cost Claude",
    tier: "$",
    recommendedGreen: true,
    aliases: [
      "claude-haiku-4.5",
      "claude-haiku-4-5",
      "claude-haiku",
      "anthropic/claude-haiku-latest",
      "anthropic/claude-haiku-4.5"
    ]
  },
  {
    displaySlug: "claude-sonnet-latest",
    openRouterSlug: "~anthropic/claude-sonnet-latest",
    nativeSlug: "claude-sonnet-5",
    provider: "anthropic",
    label: "claude-sonnet-latest (5) — balanced Claude analysis",
    tier: "$$",
    recommendedRed: true,
    aliases: [
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "claude-sonnet-4.6",
      "claude-sonnet",
      "anthropic/claude-sonnet-latest",
      "anthropic/claude-sonnet-5"
    ]
  },
  {
    displaySlug: "claude-opus-latest",
    openRouterSlug: "~anthropic/claude-opus-latest",
    nativeSlug: "claude-opus-5",
    provider: "anthropic",
    label: "claude-opus-latest (5) — premium Claude reasoning",
    tier: "$$$",
    aliases: [
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4.8",
      "claude-opus",
      "anthropic/claude-opus-latest",
      "anthropic/claude-opus-5"
    ]
  },
  {
    displaySlug: "claude-fable-latest",
    openRouterSlug: "~anthropic/claude-fable-latest",
    nativeSlug: "claude-fable-5",
    provider: "anthropic",
    label: "claude-fable-latest (5) — most capable Claude",
    tier: "$$$",
    aliases: ["claude-fable-5", "claude-fable", "anthropic/claude-fable-latest", "anthropic/claude-fable-5"]
  },
  {
    displaySlug: "grok-build-0.1",
    openRouterSlug: "x-ai/grok-build-0.1",
    nativeSlug: "grok-build-0.1",
    provider: "xai",
    label: "grok-build-0.1 — coding specialist",
    tier: "$",
    aliases: ["grok-build-latest", "x-ai/grok-build-0.1", "xai/grok-build-0.1"]
  },
  {
    displaySlug: "grok-latest",
    openRouterSlug: "~x-ai/grok-latest",
    nativeSlug: "grok-4.5",
    provider: "xai",
    label: "grok-latest (4.5) — default Grok analysis",
    tier: "$$",
    aliases: ["grok-4.5", "grok-4.3", "grok", "x-ai/grok-latest", "x-ai/grok-4.5", "xai/grok-latest"]
  },
  {
    displaySlug: "gemini-flash-lite-latest",
    openRouterSlug: "google/gemini-3.5-flash-lite",
    nativeSlug: "gemini-flash-lite-latest",
    provider: "gemini",
    label: "gemini-flash-lite-latest — low-cost Gemini",
    tier: "$",
    aliases: [
      "gemini-3.5-flash-lite",
      "gemini-3.1-flash-lite",
      "gemini-2.5-flash-lite",
      "google/gemini-3.5-flash-lite",
      "google/gemini-flash-lite-latest"
    ]
  },
  {
    displaySlug: "gemini-flash-latest",
    openRouterSlug: "~google/gemini-flash-latest",
    nativeSlug: "gemini-flash-latest",
    provider: "gemini",
    label: "gemini-flash-latest — current flagship Flash",
    tier: "$$",
    recommendedGreen: true,
    aliases: [
      "gemini-3.7-flash",
      "gemini-3.6-flash",
      "gemini-3.5-flash",
      "gemini-2.5-flash",
      "gemini-flash",
      "google/gemini-flash-latest",
      "google/gemini-3.7-flash",
      "google/gemini-3.6-flash"
    ]
  },
  {
    displaySlug: "gemini-pro-latest",
    openRouterSlug: "~google/gemini-pro-latest",
    nativeSlug: "gemini-pro-latest",
    provider: "gemini",
    label: "gemini-pro-latest — deepest Gemini reasoning",
    tier: "$$$",
    recommendedRed: true,
    aliases: [
      "gemini-3.1-pro-preview",
      "gemini-2.5-pro",
      "gemini-pro",
      "google/gemini-pro-latest",
      "google/gemini-3.1-pro-preview"
    ]
  },
  {
    displaySlug: "mistral-small-latest",
    openRouterSlug: "mistralai/mistral-small-2603",
    nativeSlug: "mistral-small-latest",
    provider: "mistral",
    label: "mistral-small-latest — low-cost Mistral Small",
    tier: "$",
    aliases: [
      "mistral-small-2603",
      "mistral-small-2506",
      "mistralai/mistral-small-2603",
      "mistralai/mistral-small-latest"
    ]
  },
  {
    displaySlug: "mistral-medium-latest",
    openRouterSlug: "mistralai/mistral-medium-3.5",
    nativeSlug: "mistral-medium-latest",
    provider: "mistral",
    label: "mistral-medium-latest — frontier Mistral Medium",
    tier: "$$",
    aliases: [
      "mistral-medium-3.5",
      "mistral-medium-3-5",
      "mistralai/mistral-medium-3.5",
      "mistralai/mistral-medium-3-5",
      "mistralai/mistral-medium-latest"
    ]
  },
  {
    displaySlug: "mistral-large-latest",
    openRouterSlug: "mistralai/mistral-large",
    nativeSlug: "mistral-large-latest",
    provider: "mistral",
    label: "mistral-large-latest — Mistral Large",
    tier: "$$$",
    aliases: ["mistral-large", "mistral-large-2512", "mistralai/mistral-large", "mistralai/mistral-large-latest"]
  },
  {
    displaySlug: "kimi-latest",
    openRouterSlug: "~moonshotai/kimi-latest",
    nativeSlug: "kimi-latest",
    provider: "moonshot",
    label: "kimi-latest (k3) — Kimi frontier model",
    tier: "$$",
    aliases: ["kimi-k3", "kimi", "moonshot", "moonshot-latest", "moonshotai/kimi-latest", "~moonshotai/kimi-latest"]
  },
  {
    displaySlug: "deepseek-flash-latest",
    openRouterSlug: "deepseek/deepseek-v4-flash",
    nativeSlug: "deepseek-v4-flash",
    provider: "deepseek",
    label: "deepseek-flash-latest (v4) — fast DeepSeek Flash",
    tier: "$",
    aliases: ["deepseek-v4-flash", "deepseek-chat", "deepseek/deepseek-v4-flash", "deepseek/deepseek-flash-latest"]
  },
  {
    displaySlug: "deepseek-pro-latest",
    openRouterSlug: "deepseek/deepseek-v4-pro",
    nativeSlug: "deepseek-v4-pro",
    provider: "deepseek",
    label: "deepseek-pro-latest (v4) — stronger DeepSeek Pro",
    tier: "$$",
    aliases: ["deepseek-v4-pro", "deepseek/deepseek-v4-pro", "deepseek/deepseek-pro-latest"]
  },
  {
    displaySlug: "deepseek-r1",
    openRouterSlug: "deepseek/deepseek-r1",
    nativeSlug: "deepseek-reasoner",
    provider: "deepseek",
    label: "deepseek-r1 — reasoning DeepSeek R1",
    tier: "$$$",
    aliases: ["deepseek-reasoner", "deepseek-r1-latest", "deepseek/deepseek-r1", "deepseek/deepseek-reasoner"]
  },
  {
    displaySlug: "llama-3.3-70b-instruct",
    openRouterSlug: "meta-llama/llama-3.3-70b-instruct",
    nativeSlug: "llama-3.3-70b-instruct",
    provider: "meta",
    label: "llama-3.3-70b-instruct — flagship open-weights analysis",
    tier: "$$",
    aliases: ["llama-70b-latest", "meta-llama/llama-3.3-70b-instruct"]
  }
];

export const CATALOG_DISPLAY_SLUGS: readonly string[] = LLM_MODEL_CATALOG.map((row) => row.displaySlug);

const LOOKUP = new Map<string, LlmCatalogEntry>();

function indexKey(raw: string): string {
  return raw.trim().replace(/^~/, "").replace(/^openrouter\//i, "").replace(/:batch$/i, "").toLowerCase();
}

for (const entry of LLM_MODEL_CATALOG) {
  LOOKUP.set(indexKey(entry.displaySlug), entry);
  LOOKUP.set(indexKey(entry.openRouterSlug), entry);
  LOOKUP.set(indexKey(entry.nativeSlug), entry);
  for (const alias of entry.aliases) {
    LOOKUP.set(indexKey(alias), entry);
  }
}

export function catalogEntryFor(model: string | null | undefined): LlmCatalogEntry | undefined {
  if (!model) return undefined;
  const trimmed = model.trim();
  if (!trimmed) return undefined;
  const direct = LOOKUP.get(indexKey(trimmed));
  if (direct) return direct;
  const leaf = trimmed.includes("/") ? trimmed.split("/").pop() || trimmed : trimmed;
  return LOOKUP.get(indexKey(leaf));
}

/** Persist / UI / stats identity.  Empty string for null/blank. */
export function displaySlugFor(model: string | null | undefined): string {
  if (!model) return "";
  const trimmed = model.trim();
  if (!trimmed) return "";
  return catalogEntryFor(trimmed)?.displaySlug ?? "";
}

/** OpenRouter chat/completions `model`.  Unknown ids keep a vendor-prefixed fallback. */
export function openRouterSlugFor(model: string | null | undefined): string {
  const trimmed = (model ?? "").trim();
  if (!trimmed) return "";
  const batch = /:batch$/i.test(trimmed);
  const entry = catalogEntryFor(trimmed);
  if (entry) {
    // The Flash-latest alias has no :batch sibling. Pin offline/eval to 3.7 batch.
    if (batch && entry.displaySlug === "gemini-flash-latest") {
      return "google/gemini-3.7-flash:batch";
    }
    return batch && !entry.openRouterSlug.endsWith(":batch") ? `${entry.openRouterSlug}:batch` : entry.openRouterSlug;
  }
  return "";
}

/**
 * Direct-provider slug.  Never returns an OpenRouter vendor path
 * (`anthropic/…`, `openai/…`) so a future native client cannot send column 2 by accident.
 */
export function nativeSlugFor(model: string | null | undefined): string {
  const trimmed = (model ?? "").trim();
  if (!trimmed) return "";
  const entry = catalogEntryFor(trimmed);
  if (entry) return entry.nativeSlug;
  const bare = trimmed.replace(/^~/, "").replace(/^openrouter\//i, "").replace(/:batch$/i, "");
  return bare.includes("/") ? bare.split("/").pop() || bare : bare;
}

export const ROTATION_EXCLUDED_DISPLAY_SLUGS: readonly string[] = ["grok-build-0.1"];

export const CATALOG_ROTATION_POOL: readonly string[] = CATALOG_DISPLAY_SLUGS.filter(
  (id) => !ROTATION_EXCLUDED_DISPLAY_SLUGS.includes(id)
);
