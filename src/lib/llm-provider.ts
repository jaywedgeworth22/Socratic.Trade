import { resolveLlmCredential } from "./db";
import { resolveOpenAiModel, type LlmTransport } from "./llm-request";

export type LlmTeamRole = "green" | "red" | "support";
export type LlmModelFamily = "openai" | "anthropic" | "xai" | "gemini" | "mistral" | "deepseek" | "openrouter";

export interface LlmEndpoint {
  provider: "openai" | "anthropic" | "xai" | "gemini" | "mistral" | "deepseek" | "openrouter";
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
  return "openrouter";
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
export function resolveLlmEndpoint(
  policy?: { llmModel?: string | null; redTeamLlmModel?: string | null } | null,
  userId: string = "local",
  // Each OpenAI call site historically defaulted to either the responses API or
  // chat-completions; pass the site's original default to preserve its transport.
  defaultOpenAiUrl: string = "https://api.openai.com/v1/responses",
  role: LlmTeamRole = "green"
): LlmEndpoint {

  const model = resolveRoleModel(policy, role);

  const url =
    process.env.OPENROUTER_API_URL?.trim() ||
    "https://openrouter.ai/api/v1/chat/completions";
  const cred = resolveLlmCredential("openrouter", userId);
  return {
    provider: "openrouter",
    url,
    key: cred.key,
    model: model.replace(/^openrouter\//i, ""),
    keySource: cred.source === "operator" ? "operator" : "user",
    keyRef: cred.keyRef,
    transport: "chat-completions"
  };
}
