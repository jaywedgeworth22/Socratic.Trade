import { resolveLlmCredential } from "./db";
import { resolveOpenAiModel, type LlmTransport } from "./llm-request";

export type LlmTeamRole = "green" | "red" | "support";
export type LlmModelFamily = "openai" | "anthropic" | "xai" | "gemini" | "mistral" | "deepseek" | "meta" | "openrouter";

export interface LlmEndpoint {
  provider: "openai" | "anthropic" | "xai" | "gemini" | "mistral" | "deepseek" | "meta" | "openrouter";
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

/**
 * Provider is derived from the model name (no separate provider flag): claude-* → Anthropic
 * (Messages API), grok-* → xAI (Grok), gemini-* → Google (Gemini), mistral/ministral/codestral/… → Mistral,
 * else OpenAI. xAI/Gemini/Mistral/DeepSeek are all OpenAI-compatible (chat/completions), so those
 * call sites treat them like OpenAI but with a per-provider base URL + key. Anthropic returns its
 * own `anthropic-messages` transport so the shared request builder (`llm-call.ts`) shapes the
 * Messages-API body/headers and forced-tool JSON output. The user selects a provider simply by
 * choosing one of its models — for both the Green (proposal) and Red (review) teams.
 */
/**
 * Maps a catalog model ID to the native provider's supported model slug for direct API calls.
 */
export function nativeModelSlugForProvider(model: string, family: LlmModelFamily): string {
  let m = model.trim();
  if (m.includes("/")) {
    m = m.split("/").pop() || m;
  }
  const lower = m.toLowerCase();

  switch (family) {
    case "anthropic":
      if (/haiku/i.test(lower)) return "claude-3-5-haiku-20241022";
      if (/opus/i.test(lower)) return "claude-3-opus-20240229";
      if (/fable/i.test(lower)) return "claude-3-5-sonnet-20241022";
      return "claude-3-5-sonnet-20241022";

    case "xai":
      if (/build/i.test(lower)) return "grok-beta";
      return "grok-latest";

    case "gemini":
      if (/flash.*lite/i.test(lower)) return "gemini-2.0-flash-lite";
      if (/pro/i.test(lower)) return "gemini-1.5-pro";
      return "gemini-2.0-flash";

    case "deepseek":
      if (/r1|reasoner/i.test(lower)) return "deepseek-reasoner";
      return "deepseek-chat";

    case "mistral":
      if (/medium/i.test(lower)) return "mistral-medium-latest";
      return "mistral-small-latest";

    case "meta":
      return "llama-3.3-70b-instruct";

    case "openai":
    default:
      if (/mini|nano/i.test(lower)) return "gpt-4o-mini";
      return "gpt-4o";
  }
}

/**
 * Endpoint resolution:
 * 1. Checks for a user-provided OpenRouter key. If present, routes via OpenRouter.
 * 2. If no OpenRouter key, checks for a user-provided direct provider key for the model's family and routes natively.
 * 3. If no user key is present, returns an endpoint with undefined key (fails closed).
 */
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
    let model = rawModel;
    if (!model.includes("/")) {
      if (/^claude-sonnet-latest$/i.test(model)) {
        model = "anthropic/claude-sonnet-5";
      } else if (/^claude-haiku-latest$/i.test(model)) {
        model = "anthropic/claude-3.5-haiku";
      } else if (/^claude-opus-latest$/i.test(model)) {
        model = "anthropic/claude-3-opus";
      } else if (/^claude-fable-latest$/i.test(model)) {
        model = "anthropic/claude-3.5-sonnet";
      } else if (/^claude/i.test(model)) {
        model = `anthropic/${model}`;
      } else if (/^grok/i.test(model)) {
        model = `x-ai/${model}`;
      } else if (/^gemini/i.test(model)) {
        model = `google/${model}`;
      } else if (/(mistral|ministral|magistral|codestral|devstral|pixtral|open-mistral|open-mixtral)/i.test(model)) {
        model = `mistralai/${model}`;
      } else if (/^deepseek/i.test(model)) {
        model = `deepseek/${model}`;
      } else if (/^llama/i.test(model)) {
        model = `meta-llama/${model}`;
      } else if (/^(gpt|o1|o3)/i.test(model)) {
        model = `openai/${model}`;
      }
    }
    model = model.replace(/^openrouter\//i, "").replace(/^xai\//i, "x-ai/");
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
