import { resolveLlmCredential } from "./db";
import { resolveOpenAiModel, type OpenAiTransport } from "./llm-request";

export type LlmTeamRole = "green" | "red" | "support";

export interface LlmEndpoint {
  provider: "openai" | "xai" | "gemini" | "mistral";
  url: string;
  key?: string;
  model: string;
  keySource: "operator" | "user";
  keyRef?: string;
  transport: OpenAiTransport;
}

function resolveRoleModel(policy: { llmModel?: string | null; redTeamLlmModel?: string | null } | undefined | null, role: LlmTeamRole): string {
  const redModel = role === "red" ? policy?.redTeamLlmModel?.trim() : undefined;
  return redModel || resolveOpenAiModel(policy);
}

/**
 * Provider is derived from the model name (no separate provider flag): grok-* → xAI, gemini-* →
 * Google Gemini, mistral/ministral/codestral/… → Mistral, else OpenAI. xAI/Gemini/Mistral are all
 * OpenAI-compatible (chat/completions), so the call sites treat them like OpenAI but with a
 * per-provider base URL + key. The user selects a provider simply by choosing one of its models.
 * The Anthropic chat path is NOT affected by this function (it has its own Messages loop).
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

  if (/^grok/i.test(model)) {
    const url =
      process.env.XAI_API_URL?.trim() ||
      "https://api.x.ai/v1/chat/completions";
    const cred = resolveLlmCredential("xai", userId);
    return {
      provider: "xai",
      url,
      key: cred.key,
      model,
      keySource: cred.source === "operator" ? "operator" : "user",
      keyRef: cred.keyRef,
      transport: "chat-completions"
    };
  }

  if (/^gemini/i.test(model)) {
    const url =
      process.env.GEMINI_API_URL?.trim() ||
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
    const cred = resolveLlmCredential("gemini", userId);
    return {
      provider: "gemini",
      url,
      key: cred.key,
      model,
      keySource: cred.source === "operator" ? "operator" : "user",
      keyRef: cred.keyRef,
      transport: "chat-completions"
    };
  }

  if (/^(mistral|ministral|magistral|codestral|devstral|pixtral|open-mistral|open-mixtral)/i.test(model)) {
    const url =
      process.env.MISTRAL_API_URL?.trim() ||
      "https://api.mistral.ai/v1/chat/completions";
    const cred = resolveLlmCredential("mistral", userId);
    return {
      provider: "mistral",
      url,
      key: cred.key,
      model,
      keySource: cred.source === "operator" ? "operator" : "user",
      keyRef: cred.keyRef,
      transport: "chat-completions"
    };
  }

  const url = process.env.OPENAI_API_URL?.trim() || defaultOpenAiUrl;
  const cred = resolveLlmCredential("openai", userId);
  const transport: OpenAiTransport = url.includes("/chat/completions")
    ? "chat-completions"
    : "responses";
  return {
    provider: "openai",
    url,
    key: cred.key,
    model,
    keySource: cred.source === "operator" ? "operator" : "user",
    keyRef: cred.keyRef,
    transport
  };
}
