export type OpenAiTransport = "responses" | "chat-completions";

export const LLM_REQUEST_DEFAULTS = {
  deterministicTemperature: 0,
  maxOutputTokens: 1500
} as const;

/** Hard wall-clock cap on a single LLM HTTP call. A half-open OpenAI/Anthropic connection
 *  otherwise hangs the caller indefinitely — and for the strategy run that means holding the
 *  per-user run lock (starving the scheduler) with no error to alert on. */
export const LLM_TIMEOUT_MS = 60_000;

/**
 * fetch() for LLM endpoints with a bounded timeout. On expiry the request is aborted and the
 * promise rejects (AbortError), which every call site already treats as an LLM failure (falls
 * back / surfaces an error) rather than hanging forever. A caller may pass its own `signal`.
 */
export function llmFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(LLM_TIMEOUT_MS) });
}

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
