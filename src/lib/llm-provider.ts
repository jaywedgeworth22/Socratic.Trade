import { resolveLlmCredential } from "./db";
import { resolveOpenAiModel, type OpenAiTransport } from "./llm-request";

export type LlmTeamRole = "green" | "red" | "support";

export interface LlmEndpoint {
  provider: "openai" | "xai";
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
 * Provider is derived from the model name: grok-* → xAI (OpenAI-compatible), else OpenAI.
 * Lets a user select Grok simply by choosing a grok-* model; no separate provider flag.
 * The Anthropic chat path is NOT affected by this function.
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
