import type { LlmReasoningEffort } from "./types";

export type OpenAiTransport = "responses" | "chat-completions";

/** Default model when neither the per-user policy nor OPENAI_MODEL is set. */
export const DEFAULT_OPENAI_MODEL = "gpt-5.4-mini";

/**
 * OpenAI "reasoning" models (gpt-5 family, o-series). They REJECT the `temperature` param
 * (400 "Only the default (1) value is supported") and instead take `reasoning_effort`. They also
 * spend output budget on hidden reasoning tokens, so the visible-output cap must be raised.
 */
export function isReasoningModel(model: string | undefined): boolean {
  return /^(gpt-5|o\d)/i.test((model ?? "").trim());
}

/** Resolve the per-user model: explicit policy choice → OPENAI_MODEL env → default. */
export function resolveOpenAiModel(policy?: { llmModel?: string | null } | null): string {
  const fromPolicy = policy?.llmModel?.trim();
  if (fromPolicy) return fromPolicy;
  return process.env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL;
}

/** Extra output-token headroom for reasoning models (hidden reasoning tokens are billed as output). */
const REASONING_TOKEN_BUDGET: Record<LlmReasoningEffort, number> = {
  low: 2000,
  medium: 4000,
  high: 8000
};

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
  /** The target model — determines whether to send temperature (classic) or reasoning_effort (gpt-5/o). */
  model: string;
  temperature?: number;
  /** Reasoning effort for reasoning models. Defaults to "medium"; ignored by classic models. */
  reasoningEffort?: LlmReasoningEffort;
};

export function withLlmRequestBounds<T extends Record<string, unknown>>(
  body: T,
  transport: OpenAiTransport,
  bounds: RequestBounds
): T & Record<string, unknown> {
  if (isReasoningModel(bounds.model)) {
    // Reasoning models reject `temperature`; steer with `reasoning_effort` and give the output cap
    // extra headroom so hidden reasoning tokens don't starve the visible JSON answer.
    const effort: LlmReasoningEffort = bounds.reasoningEffort ?? "medium";
    const maxOutputTokens = bounds.maxOutputTokens + REASONING_TOKEN_BUDGET[effort];
    if (transport === "responses") {
      return { ...body, max_output_tokens: maxOutputTokens, reasoning: { effort } };
    }
    return { ...body, max_completion_tokens: maxOutputTokens, reasoning_effort: effort };
  }

  const temperature = bounds.temperature ?? LLM_REQUEST_DEFAULTS.deterministicTemperature;
  if (transport === "responses") {
    return { ...body, max_output_tokens: bounds.maxOutputTokens, temperature };
  }
  return { ...body, max_completion_tokens: bounds.maxOutputTokens, temperature };
}
