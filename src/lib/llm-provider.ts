import { resolveLlmCredential } from "./db";
import { nativeSlugFor, openRouterSlugFor } from "./llm-model-catalog";
import { resolveOpenAiModel, type LlmTransport } from "./llm-request";

export type LlmTeamRole = "green" | "red" | "support";
export type LlmModelFamily = "openai" | "anthropic" | "xai" | "gemini" | "mistral" | "deepseek" | "meta" | "moonshot" | "openrouter";

export interface LlmEndpoint {
  provider: "openai" | "anthropic" | "xai" | "gemini" | "mistral" | "deepseek" | "meta" | "moonshot" | "openrouter";
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
  if (/llama/i.test(normalized)) return "meta";
  if (/(kimi|moonshot)/i.test(normalized)) return "moonshot";
  return "openai";
}

/**
 * The credential SERVICE whose key must resolve for a model under universal OpenRouter routing.
 * Production serves EVERY model through the OpenRouter credential (see `resolveLlmEndpoint`), so
 * that's what eligibility/save-gate checks must key on — an OpenRouter-only account must not be
 * rejected for lacking an (unused) native key. Under NODE_ENV=test we key the native family so the
 * existing native-key test fixtures keep resolving. Single source of truth so `resolveLlmEndpoint`,
 * rotation eligibility, and the policy save-gate never drift.
 */
export function modelCredentialService(model: string | undefined): LlmModelFamily {
  return process.env.NODE_ENV === "test" ? llmModelFamily(model) : "openrouter";
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

/** Current OpenRouter Flash class — catalog column 2. */
export const OPENROUTER_GEMINI_FLASH = "google/gemini-flash-latest";
/** OpenRouter Flash batch/offline variant (~50% cheaper, higher latency). */
export const OPENROUTER_GEMINI_FLASH_BATCH = "google/gemini-flash-latest:batch";
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
  const unprefixed = stripOpenRouterTilde(model);
  if (unprefixed.includes("/")) {
    return stripOpenRouterTilde(model).replace(/^xai\//i, "x-ai/").replace(/^moonshot\//i, "moonshotai/");
  }
  if (/^claude/i.test(unprefixed)) return `anthropic/${unprefixed}`;
  if (/^grok/i.test(unprefixed)) return `x-ai/${unprefixed}`;
  if (/^gemini/i.test(unprefixed)) return `google/${unprefixed}`;
  if (/(mistral|ministral|magistral|codestral|devstral|pixtral|open-mistral|open-mixtral)/i.test(unprefixed)) {
    return `mistralai/${unprefixed}`;
  }
  if (/(kimi|moonshot)/i.test(unprefixed)) return `moonshotai/${unprefixed}`;
  if (/^deepseek/i.test(unprefixed)) return `deepseek/${unprefixed}`;
  if (/^llama/i.test(unprefixed)) return `meta-llama/${unprefixed}`;
  if (/^(gpt|o1|o3)/i.test(unprefixed)) return `openai/${unprefixed}`;
  return unprefixed;
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
  if (openRouterCred.key) {
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
