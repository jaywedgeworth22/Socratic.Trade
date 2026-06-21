export type OpenAiTransport = "responses" | "chat-completions";

export const LLM_REQUEST_DEFAULTS = {
  deterministicTemperature: 0,
  maxOutputTokens: 1500
} as const;

export const LLM_OUTPUT_TOKEN_CAPS = {
  strategyProposal: LLM_REQUEST_DEFAULTS.maxOutputTokens,
  strategyCritique: LLM_REQUEST_DEFAULTS.maxOutputTokens,
  strategyTuning: LLM_REQUEST_DEFAULTS.maxOutputTokens,
  redTeamDebate: LLM_REQUEST_DEFAULTS.maxOutputTokens,
  postMortemReflection: LLM_REQUEST_DEFAULTS.maxOutputTokens,
  proposalRevalidation: LLM_REQUEST_DEFAULTS.maxOutputTokens
} as const;

type RequestBounds = {
  maxOutputTokens: number;
  temperature?: number;
};

export function withLlmRequestBounds<T extends Record<string, unknown>>(
  body: T,
  transport: OpenAiTransport,
  bounds: RequestBounds
): T & Record<string, unknown> {
  const temperature = bounds.temperature ?? LLM_REQUEST_DEFAULTS.deterministicTemperature;

  if (transport === "responses") {
    return {
      ...body,
      max_output_tokens: bounds.maxOutputTokens,
      temperature
    };
  }

  return {
    ...body,
    max_completion_tokens: bounds.maxOutputTokens,
    temperature
  };
}
