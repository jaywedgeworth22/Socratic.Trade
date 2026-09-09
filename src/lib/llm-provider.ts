import { resolveLlmCredential } from "./db";
import { catalogEntryFor, nativeSlugFor, openRouterSlugFor } from "./llm-model-catalog";
import { resolveOpenAiModel, type LlmTransport } from "./llm-request";

export type LlmTeamRole = "green" | "red" | "support";
export type LlmModelFamily = "openai" | "anthropic" | "xai" | "gemini" | "mistral" | "deepseek" | "meta" | "moonshot" | "minimax" | "openrouter";

export interface LlmEndpoint {
  provider: "openai" | "anthropic" | "xai" | "gemini" | "mistral" | "deepseek" | "meta" | "moonshot" | "minimax" | "openrouter";
  url: string;
  key?: string;
  model: string;
  keySource: "operator" | "user";
  keyRef?: string;
  transport: LlmTransport;
}

/**
 * The model FAMILY (provider) a model name belongs to, using the same name-prefix rules
 * `resolveLlmEndpoint` uses to pick a wire transport. Exposed so callers (the cross-family Bear
 * default below) can compare families without duplicating the regexes.
 */
export function llmModelFamily(model: string | undefined): LlmModelFamily {
  let normalized = (model ?? "").trim().toLowerCase();
  normalized = normalized.replace(/^openrouter\//i, "");

  if (/claude/i.test(normalized)) return "anthropic";
  if (/grok/i.test(normalized)) return "xai";
  if (/gemini/i.test(normalized)) return "gemini";
  if (/(mistral|ministral|magistral|codestral|devstral|pixtral|open-mistral|open-mixtral)/i.test(normalized)) return "mistral";
  if (/deepseek/i.test(normalized)) return "deepseek";
  if (/(llama|muse-)/i.test(normalized)) return "meta";
  if (/(kimi|moonshot)/i.test(normalized)) return "moonshot";
  if (/minimax/i.test(normalized)) return "minimax";
  return "openai";
}

/** Explicit OpenRouter ids, Meta, and restricted catalog entries require OpenRouter transport. */
export function modelRequiresOpenRouter(model: string | undefined): boolean {
  return /^openrouter\//i.test((model ?? "").trim())
    || llmModelFamily(model) === "meta"
    || catalogEntryFor(model)?.openRouterOnly === true;
}

/** Credential gate follows the same OpenRouter-first, native-fallback routing as execution. */
export function modelCredentialService(model: string | undefined, userId: string = "local"): LlmModelFamily {
  return modelRequiresOpenRouter(model) || resolveLlmCredential("openrouter", userId).key
    ? "openrouter" : llmModelFamily(model);
}

// Cross-family Red Team DEFAULT removed 2026-07-07 (owner directive: no model is a default for
// anything, ever). The Red Team model is the user's explicit `redTeamLlmModel` or nothing;
// resolveRoleModel returns "" when unset and the caller fails closed. Independence (a different
// model/provider from Green) is the user's choice, nudged by a non-blocking Settings hint, never
// auto-defaulted.

/**
 * Resolve the model for a team role. NO DEFAULTS (owner directive 2026-07-07): the Red Team is the
 * user's explicit `redTeamLlmModel` or "" (unconfigured — the caller MUST fail closed); it NEVER
 * falls back to the Green model or a cross-family default. Green/support resolve to the user's
 * `llmModel` or "".
 */
function resolveRoleModel(
  policy: { llmModel?: string | null; redTeamLlmModel?: string | null } | undefined | null,
  role: LlmTeamRole
): string {
  if (role === "red") return policy?.redTeamLlmModel?.trim() || "";
  return resolveOpenAiModel(policy);
}

/** Current OpenRouter Flash class — catalog column 2. Bare slug 404s. */
export const OPENROUTER_GEMINI_FLASH = "~google/gemini-flash-latest";
/** Pinned 3.8 batch/offline slug (the latest alias has no :batch sibling). */
export const OPENROUTER_GEMINI_FLASH_BATCH = "google/gemini-3.8-flash:batch";
/** Google AI Studio native Flash class — catalog column 3. */
export const NATIVE_GEMINI_FLASH = "gemini-flash-latest";

/**
 * Maps a catalog / persisted model ID to the native provider slug (column 3).
 * Uses `nativeSlugFor` so a future direct path never sends an OpenRouter wire id.
 */
export function nativeModelSlugForProvider(model: string, _family: LlmModelFamily): string {
  return nativeSlugFor(model);
}

export { nativeSlugFor } from "./llm-model-catalog";

export function stripOpenRouterTilde(id: string): string {
  return id.trim().replace(/^~/, "").replace(/\/~/g, "/");
}

function prefixUnknownOpenRouterId(raw: string): string {
  const model = raw.replace(/^openrouter\//i, "");
  const keepTilde = /^\s*~/.test(model);
  const unprefixed = stripOpenRouterTilde(model);
  let out: string;
  if (unprefixed.includes("/")) {
    out = unprefixed.replace(/^xai\//i, "x-ai/").replace(/^moonshot\//i, "moonshotai/");
  } else if (/^claude/i.test(unprefixed)) {
    out = `anthropic/${unprefixed}`;
  } else if (/^grok/i.test(unprefixed)) {
    out = `x-ai/${unprefixed}`;
  } else if (/^gemini/i.test(unprefixed)) {
    out = `google/${unprefixed}`;
  } else if (/(mistral|ministral|magistral|codestral|devstral|pixtral|open-mistral|open-mixtral)/i.test(unprefixed)) {
    out = `mistralai/${unprefixed}`;
  } else if (/(kimi|moonshot)/i.test(unprefixed)) {
    out = `moonshotai/${unprefixed}`;
  } else if (/minimax/i.test(unprefixed)) {
    out = `minimax/${unprefixed}`;
  } else if (/^deepseek/i.test(unprefixed)) {
    out = `deepseek/${unprefixed}`;
  } else if (/^llama/i.test(unprefixed)) {
    out = `meta-llama/${unprefixed}`;
  } else if (/^(gpt|o1|o3)/i.test(unprefixed)) {
    out = `openai/${unprefixed}`;
  } else {
    out = unprefixed;
  }
  return keepTilde && !out.startsWith("~") ? `~${out}` : out;
}

/**
 * Normalize a catalog or persisted model name to the OpenRouter wire ID (column 2).
 * Catalog hits never send a display slug when it differs from the wire slug.
 */
export function normalizeOpenRouterModelId(rawModel: string | undefined): string {
  const catalog = openRouterSlugFor(rawModel);
  if (catalog) return catalog;
  return prefixUnknownOpenRouterId((rawModel ?? "").trim());
}


export function resolveLlmEndpoint(
  policy?: { llmModel?: string | null; redTeamLlmModel?: string | null } | null,
  userId: string = "local",
  defaultOpenAiUrl: string = "https://api.openai.com/v1/chat/completions",
  role: LlmTeamRole = "green"
): LlmEndpoint {
  const rawModel = resolveRoleModel(policy, role);
  const family = llmModelFamily(rawModel);

  // 1. Primary path: OpenRouter key (user or operator failover when enabled)
  const openRouterCred = resolveLlmCredential("openrouter", userId);
  // Meta models are served through OpenRouter; never send a Meta credential to OpenAI.
  if (openRouterCred.key || modelRequiresOpenRouter(rawModel)) {
    const model = normalizeOpenRouterModelId(rawModel);
    const url = process.env.OPENROUTER_API_URL?.trim() || "https://openrouter.ai/api/v1/chat/completions";

    return {
      provider: "openrouter",
      url,
      key: openRouterCred.key,
      model,
      keySource: openRouterCred.source === "operator" ? "operator" : "user",
      keyRef: openRouterCred.keyRef,
      transport: "chat-completions"
    };
  }

  // 2. Direct provider path: check user-provided key for model's native family
  const nativeCred = resolveLlmCredential(family, userId);
  const nativeModel = nativeModelSlugForProvider(rawModel, family);

  if (family === "anthropic") {
    return {
      provider: "anthropic",
      url: "https://api.anthropic.com/v1/messages",
      key: nativeCred.key,
      model: nativeModel,
      keySource: nativeCred.source === "operator" ? "operator" : "user",
      keyRef: nativeCred.keyRef,
      transport: "anthropic-messages"
    };
  } else if (family === "xai") {
    return {
      provider: "xai",
      url: process.env.XAI_API_URL?.trim() || "https://api.x.ai/v1/chat/completions",
      key: nativeCred.key,
      model: nativeModel,
      keySource: nativeCred.source === "operator" ? "operator" : "user",
      keyRef: nativeCred.keyRef,
      transport: "chat-completions"
    };
  } else if (family === "gemini") {
    return {
      provider: "gemini",
      url: process.env.GEMINI_API_URL?.trim() || "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      key: nativeCred.key,
      model: nativeModel,
      keySource: nativeCred.source === "operator" ? "operator" : "user",
      keyRef: nativeCred.keyRef,
      transport: "chat-completions"
    };
  } else if (family === "mistral") {
    return {
      provider: "mistral",
      url: process.env.MISTRAL_API_URL?.trim() || "https://api.mistral.ai/v1/chat/completions",
      key: nativeCred.key,
      model: nativeModel,
      keySource: nativeCred.source === "operator" ? "operator" : "user",
      keyRef: nativeCred.keyRef,
      transport: "chat-completions"
    };
  } else if (family === "deepseek") {
    return {
      provider: "deepseek",
      url: process.env.DEEPSEEK_API_URL?.trim() || "https://api.deepseek.com/v1/chat/completions",
      key: nativeCred.key,
      model: nativeModel,
      keySource: nativeCred.source === "operator" ? "operator" : "user",
      keyRef: nativeCred.keyRef,
      transport: "chat-completions"
    };
  } else if (family === "moonshot") {
    return {
      provider: "moonshot",
      url: process.env.MOONSHOT_API_URL?.trim() || "https://api.moonshot.cn/v1/chat/completions",
      key: nativeCred.key,
      model: nativeModel,
      keySource: nativeCred.source === "operator" ? "operator" : "user",
      keyRef: nativeCred.keyRef,
      transport: "chat-completions"
    };
  } else if (family === "minimax") {
    return {
      provider: "minimax",
      url: process.env.MINIMAX_API_URL?.trim() || "https://api.minimax.io/v1/chat/completions",
      key: nativeCred.key,
      model: nativeModel,
      keySource: nativeCred.source === "operator" ? "operator" : "user",
      keyRef: nativeCred.keyRef,
      transport: "chat-completions"
    };
  }

  // OpenAI / fallback
  return {
    provider: "openai",
    url: process.env.OPENAI_API_URL?.trim() || defaultOpenAiUrl,
    key: nativeCred.key,
    model: nativeModel,
    keySource: nativeCred.source === "operator" ? "operator" : "user",
    keyRef: nativeCred.keyRef,
    transport: "chat-completions"
  };
}
