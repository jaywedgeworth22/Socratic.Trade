import { resolveLlmCredential } from "./db";
import { resolveOpenAiModel, type LlmTransport } from "./llm-request";

export type LlmTeamRole = "green" | "red" | "support";

export interface LlmEndpoint {
  provider: "openai" | "anthropic" | "xai" | "gemini" | "mistral" | "deepseek";
  url: string;
  key?: string;
  model: string;
  keySource: "operator" | "user";
  keyRef?: string;
  transport: LlmTransport;
}

function resolveRoleModel(policy: { llmModel?: string | null; redTeamLlmModel?: string | null } | undefined | null, role: LlmTeamRole): string {
  const redModel = role === "red" ? policy?.redTeamLlmModel?.trim() : undefined;
  return redModel || resolveOpenAiModel(policy);
}

/**
 * Provider is derived from the model name (no separate provider flag): claude-* → Anthropic
 * (Messages API), grok-* → xAI, gemini-* → Google Gemini, mistral/ministral/codestral/… → Mistral,
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

  if (/^claude/i.test(model)) {
    const url =
      process.env.ANTHROPIC_API_URL?.trim() ||
      "https://api.anthropic.com/v1/messages";
    const cred = resolveLlmCredential("anthropic", userId);
    return {
      provider: "anthropic",
      url,
      key: cred.key,
      model,
      keySource: cred.source === "operator" ? "operator" : "user",
      keyRef: cred.keyRef,
      transport: "anthropic-messages"
    };
  }

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

  if (/^deepseek/i.test(model)) {
    const url =
      process.env.DEEPSEEK_API_URL?.trim() ||
      "https://api.deepseek.com/v1/chat/completions";
    const cred = resolveLlmCredential("deepseek", userId);
    return {
      provider: "deepseek",
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
  const transport: LlmTransport = url.includes("/chat/completions")
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
