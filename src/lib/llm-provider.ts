import { resolveLlmCredential } from "./db";
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

/** Current OpenRouter Flash class. `google/gemini-flash-latest` 404s (verified 2026-08-14). */
export const OPENROUTER_GEMINI_FLASH = "google/gemini-3.7-flash";
/** OpenRouter Flash batch/offline variant (~50% cheaper, higher latency). */
export const OPENROUTER_GEMINI_FLASH_BATCH = "google/gemini-3.7-flash:batch";
/** Google AI Studio native Flash class. */
export const NATIVE_GEMINI_FLASH = "gemini-3.7-flash";
const OPENROUTER_GEMINI_FLASH_LITE = "google/gemini-3.5-flash-lite";
const OPENROUTER_GEMINI_PRO = "google/gemini-3.1-pro-preview";
const NATIVE_GEMINI_FLASH_LITE = "gemini-3.5-flash-lite";
const NATIVE_GEMINI_PRO = "gemini-3.1-pro-preview";

/**
 * Maps a catalog model ID to the native provider's supported model slug for direct API calls.
 */
export function nativeModelSlugForProvider(model: string, family: LlmModelFamily): string {
  let m = model.trim();
  if (m.includes("/")) {
    m = m.split("/").pop() || m;
  }
  m = m.replace(/:batch$/i, "");
  const lower = m.toLowerCase();

  switch (family) {
    case "anthropic":
      if (/haiku/i.test(lower)) return "claude-haiku-4.5";
      if (/opus/i.test(lower)) return "claude-opus-5";
      if (/fable/i.test(lower)) return "claude-fable-5";
      return "claude-sonnet-5";

    case "xai":
      if (/build/i.test(lower)) return "grok-build-0.1";
      return "grok-4.5";

    case "gemini":
      if (/flash.*lite/i.test(lower)) {
        return /latest|3\.5/.test(lower) || lower === "gemini-flash-lite" ? NATIVE_GEMINI_FLASH_LITE : m;
      }
      if (/pro/i.test(lower)) {
        return /latest/.test(lower) ? NATIVE_GEMINI_PRO : m;
      }
      if (/flash/i.test(lower)) {
        return /latest|3\.6/.test(lower) || lower === "gemini-flash" ? NATIVE_GEMINI_FLASH : m;
      }
      return NATIVE_GEMINI_FLASH;

    case "deepseek":
      if (/r1|reasoner/i.test(lower)) return "deepseek-reasoner";
      if (/pro/i.test(lower)) return "deepseek-v4-pro";
      return "deepseek-v4-flash";

    case "mistral":
      if (/large/i.test(lower)) return "mistral-large-latest";
      if (/medium/i.test(lower)) return "mistral-medium-latest";
      return "mistral-small-latest";

    case "moonshot":
      return "kimi-latest";

    case "meta":
      return "llama-3.3-70b-instruct";

    case "openai":
    default:
      if (/sol/i.test(lower)) return "gpt-5.6-sol";
      if (/terra/i.test(lower)) return "gpt-5.6-terra";
      if (/luna/i.test(lower)) return "gpt-5.6-luna";
      if (/mini/i.test(lower)) return "gpt-5.4-mini";
      if (/nano/i.test(lower)) return "gpt-5.4-nano";
      if (/gpt-4o-mini/i.test(lower)) return "gpt-4o-mini";
      return "gpt-4o";
  }
}

/**
 * Normalize a catalog or persisted model name to the OpenRouter wire ID. Keep this beside
 * resolveLlmEndpoint so availability probes and actual calls cannot disagree about a model's ID.
 * Includes the latest aliases used in Settings catalogs.
 */
export function normalizeOpenRouterModelId(rawModel: string | undefined): string {
  let model = (rawModel ?? "").trim();
  if (!model.includes("/")) {
    if (/^claude-sonnet/i.test(model)) {
      model = "anthropic/claude-sonnet-latest";
    } else if (/^claude-haiku/i.test(model)) {
      model = "anthropic/claude-haiku-latest";
    } else if (/^claude-opus/i.test(model)) {
      model = "anthropic/claude-opus-latest";
    } else if (/^claude-fable/i.test(model)) {
      model = "anthropic/claude-fable-latest";
    } else if (/^claude/i.test(model)) {
      model = `anthropic/${model}`;
    } else if (/^grok-build/i.test(model)) {
      model = "x-ai/grok-build-0.1";
    } else if (/^grok/i.test(model)) {
      model = "x-ai/grok-latest";
    } else if (/^gemini-flash-lite/i.test(model) || /^gemini-3.5-flash-lite$/i.test(model)) {
      model = OPENROUTER_GEMINI_FLASH_LITE;
    } else if (/^gemini-flash-latest$/i.test(model) || /^gemini-3.6-flash$/i.test(model) || /^gemini-flash$/i.test(model)) {
      model = OPENROUTER_GEMINI_FLASH;
    } else if (/^gemini-pro-latest$/i.test(model) || /^gemini-pro$/i.test(model)) {
      model = OPENROUTER_GEMINI_PRO;
    } else if (/^gemini/i.test(model)) {
      model = `google/${model}`;
    } else if (/^gpt-sol/i.test(model) || /^gpt-5.6-sol$/i.test(model)) {
      model = "openai/gpt-5.6-sol";
    } else if (/^gpt-terra/i.test(model) || /^gpt-5.6-terra$/i.test(model)) {
      model = "openai/gpt-5.6-terra";
    } else if (/^gpt-luna/i.test(model) || /^gpt-5.6-luna$/i.test(model)) {
      model = "openai/gpt-5.6-luna";
    } else if (/^gpt-mini-latest/i.test(model) || /^gpt-5.4-mini$/i.test(model)) {
      model = "openai/gpt-mini-latest";
    } else if (/^gpt-nano/i.test(model) || /^gpt-5.4-nano$/i.test(model)) {
      model = "openai/gpt-5.4-nano";
    } else if (/^gpt-4o-mini$/i.test(model)) {
      model = "openai/gpt-4o-mini";
    } else if (/^gpt-4o/i.test(model)) {
      model = "openai/gpt-4o";
    } else if (/^mistral-large/i.test(model)) {
      model = "mistralai/mistral-large";
    } else if (/^mistral-medium/i.test(model)) {
      model = "mistralai/mistral-medium-3.5";
    } else if (/^mistral-small/i.test(model)) {
      model = "mistralai/mistral-small-2603";
    } else if (/(mistral|ministral|magistral|codestral|devstral|pixtral|open-mistral|open-mixtral)/i.test(model)) {
      model = `mistralai/${model}`;
    } else if (/(kimi|moonshot)/i.test(model)) {
      model = "moonshotai/kimi-latest";
    } else if (/^deepseek-flash/i.test(model)) {
      model = "deepseek/deepseek-v4-flash";
    } else if (/^deepseek-pro/i.test(model)) {
      model = "deepseek/deepseek-v4-pro";
    } else if (/^deepseek-r1/i.test(model)) {
      model = "deepseek/deepseek-r1";
    } else if (/^deepseek/i.test(model)) {
      model = `deepseek/${model}`;
    } else if (/^llama/i.test(model)) {
      model = "meta-llama/llama-3.3-70b-instruct";
    } else if (/^(gpt|o1|o3)/i.test(model)) {
      model = `openai/${model}`;
    }
  }
  model = model.replace(/^openrouter\//i, "").replace(/^xai\//i, "x-ai/").replace(/^moonshot\//i, "moonshotai/");
  // Dead / previous-class OpenRouter aliases → current Flash / Pro class.
  if (/^google\/gemini-flash-latest(?::batch)?$/i.test(model) || /^google\/gemini-3\.6-flash(?::batch)?$/i.test(model)) {
    return /:batch$/i.test(model) ? OPENROUTER_GEMINI_FLASH_BATCH : OPENROUTER_GEMINI_FLASH;
  }
  if (/^google\/gemini-pro-latest$/i.test(model)) {
    return OPENROUTER_GEMINI_PRO;
  }
  return model;
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
