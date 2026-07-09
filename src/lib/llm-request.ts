import type { LlmReasoningEffort } from "./types";

/** OpenAI and OpenAI-compatible (xAI/Gemini/Mistral/DeepSeek) HTTP shapes. */
export type OpenAiTransport = "responses" | "chat-completions";
export type LlmReasoningProvider = "openai" | "anthropic" | "xai" | "gemini" | "mistral" | "deepseek";

export interface LlmReasoningOption {
  value: LlmReasoningEffort;
  label: string;
  hint: string;
}

export interface LlmReasoningCapability {
  provider: LlmReasoningProvider;
  label: string;
  settingLabel: string;
  description: string;
  options: LlmReasoningOption[];
}

/**
 * Every LLM wire transport the app speaks. Anthropic's Messages API ("anthropic-messages") is NOT
 * OpenAI-compatible (top-level `system`, `max_tokens`, `x-api-key` header, content-block responses,
 * forced tool-use for structured JSON), so it is modelled as its own transport rather than folded
 * into the OpenAI-compatible pair. See `llm-call.ts` for the per-transport request/response shaping.
 */
export type LlmTransport = OpenAiTransport | "anthropic-messages";

// DEFAULT_OPENAI_MODEL removed 2026-07-07 (owner directive: no model is a default for anything,
// ever). Strategy Green/Red resolve to explicit per-user choices ("" when unset → fail closed);
// the chat assistant requires an explicit per-request model or CHAT_LLM_MODEL (no hardcoded model).

/**
 * OpenAI "reasoning" models (gpt-5 family, o-series). They REJECT the `temperature` param
 * (400 "Only the default (1) value is supported") and instead take `reasoning_effort`. They also
 * spend output budget on hidden reasoning tokens, so the visible-output cap must be raised.
 */
export function isReasoningModel(model: string | undefined): boolean {
  return /^(gpt-5|o\d)/i.test((model ?? "").trim());
}

/**
 * Resolve the per-user Green (strategist/proposer) model. NO DEFAULT — owner directive
 * (2026-07-07): no model is a default for anything, ever. Both the Green (`llmModel`) and Red
 * (`redTeamLlmModel`) team models must be explicitly chosen in Settings, and it is enforced
 * impossible to save a policy without them (app/api/policy/route.ts). Returns "" when unchosen;
 * callers MUST treat "" as unconfigured and fail closed (route to human / skip the run), never
 * send an empty-model request. The former `OPENAI_MODEL`-env and `DEFAULT_OPENAI_MODEL` strategy
 * fallbacks are deliberately removed.
 */
export function resolveOpenAiModel(policy?: { llmModel?: string | null } | null): string {
  return policy?.llmModel?.trim() || "";
}

export const ALL_LLM_REASONING_EFFORTS: readonly LlmReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

const REASONING_OPTION_BY_VALUE: Record<LlmReasoningEffort, LlmReasoningOption> = {
  none: { value: "none", label: "None", hint: "Disable provider-side thinking where that provider allows it." },
  minimal: { value: "minimal", label: "Minimal", hint: "Smallest supported thinking budget above off." },
  low: { value: "low", label: "Low", hint: "Lower latency and cost; less deliberate analysis." },
  medium: { value: "medium", label: "Medium", hint: "Balanced depth, latency, and cost." },
  high: { value: "high", label: "High", hint: "Deeper analysis with higher latency and token use." },
  xhigh: { value: "xhigh", label: "XHigh", hint: "Extra-high provider thinking budget where supported." },
  max: { value: "max", label: "Max", hint: "Provider maximum thinking budget where supported." }
};

function options(values: readonly LlmReasoningEffort[]): LlmReasoningOption[] {
  return values.map((value) => REASONING_OPTION_BY_VALUE[value]);
}

function lowerModel(model: string | undefined): string {
  return (model ?? "").trim().toLowerCase();
}

function isAnthropicAdaptiveThinkingModel(model: string | undefined): boolean {
  const normalized = lowerModel(model);
  return (
    /^claude-fable-5(?:$|[-.:_])/.test(normalized) ||
    /^claude-mythos-5(?:$|[-.:_])/.test(normalized) ||
    /^claude-opus-4-(?:6|7|8)(?:$|[-.:_])/.test(normalized) ||
    /^claude-sonnet-(?:5|4-6)(?:$|[-.:_])/.test(normalized)
  );
}

function isXaiReasoningModel(model: string | undefined): boolean {
  return /^grok-4(?:\.3)?(?:$|[-.:_])/.test(lowerModel(model));
}

function isGeminiModel(model: string | undefined): boolean {
  return /^gemini(?:$|[-.:_])/.test(lowerModel(model));
}

function geminiAllowsThinkingOff(model: string | undefined): boolean {
  return /^gemini-2\.5-(?:flash|flash-lite)(?:$|[-.:_])/.test(lowerModel(model));
}

function isMistralModel(model: string | undefined): boolean {
  return /^(mistral|ministral|magistral|codestral|devstral|pixtral|open-mistral|open-mixtral)(?:$|[-.:_])/.test(lowerModel(model));
}

function isDeepSeekV4Model(model: string | undefined): boolean {
  return /^deepseek-v4-(?:flash|pro)(?:$|[-.:_])/.test(lowerModel(model));
}

export function reasoningCapabilityForModel(model: string | undefined): LlmReasoningCapability | undefined {
  if (isReasoningModel(model)) {
    return {
      provider: "openai",
      label: "OpenAI Reasoning",
      settingLabel: "Reasoning Effort",
      description: "OpenAI gpt-5/o-series models use reasoning effort and reject custom temperature.",
      options: options(["low", "medium", "high"])
    };
  }
  if (isAnthropicAdaptiveThinkingModel(model)) {
    return {
      provider: "anthropic",
      label: "Claude Adaptive Thinking",
      settingLabel: "Thinking Effort",
      description: "Recent Claude models use adaptive thinking with provider-specific effort levels.",
      options: options(["low", "medium", "high", "xhigh", "max"])
    };
  }
  if (isXaiReasoningModel(model)) {
    return {
      provider: "xai",
      label: "Grok Reasoning",
      settingLabel: "Reasoning Effort",
      description: "Grok reasoning models accept none/low/medium/high effort.",
      options: options(["none", "low", "medium", "high"])
    };
  }
  if (isGeminiModel(model)) {
    return {
      provider: "gemini",
      label: "Gemini Thinking",
      settingLabel: "Thinking Level",
      description: geminiAllowsThinkingOff(model)
        ? "Gemini thinking can be disabled or scaled on selected 2.5 Flash models."
        : "Gemini thinking can be scaled, but this model family does not support turning it fully off.",
      options: options(geminiAllowsThinkingOff(model) ? ["none", "minimal", "low", "medium", "high"] : ["minimal", "low", "medium", "high"])
    };
  }
  if (isMistralModel(model)) {
    return {
      provider: "mistral",
      label: "Mistral Reasoning",
      settingLabel: "Reasoning Effort",
      description: "Mistral chat completions expose provider-specific reasoning effort levels.",
      options: options(["none", "minimal", "low", "medium", "high", "xhigh"])
    };
  }
  if (isDeepSeekV4Model(model)) {
    return {
      provider: "deepseek",
      label: "DeepSeek Thinking",
      settingLabel: "Thinking Mode",
      description: "DeepSeek V4 can disable thinking or use high/max thinking effort.",
      options: options(["none", "high", "max"])
    };
  }
  return undefined;
}

export function normalizeReasoningEffortForOptions(
  optionsForModel: readonly Pick<LlmReasoningOption, "value">[],
  effort: LlmReasoningEffort | undefined
): LlmReasoningEffort {
  const allowed = optionsForModel.map((option) => option.value);
  if (allowed.length === 0) return "medium";
  if (effort === undefined) return allowed.includes("medium") ? "medium" : (allowed[0] ?? "medium");
  const requested = effort;
  if (allowed.includes(requested)) return requested;
  const requestedRank = ALL_LLM_REASONING_EFFORTS.indexOf(requested);
  const rankedAllowed = allowed
    .map((value) => ({ value, distance: Math.abs(ALL_LLM_REASONING_EFFORTS.indexOf(value) - requestedRank) }))
    .sort((a, b) => a.distance - b.distance || ALL_LLM_REASONING_EFFORTS.indexOf(a.value) - ALL_LLM_REASONING_EFFORTS.indexOf(b.value));
  return rankedAllowed[0]?.value ?? allowed[0] ?? "medium";
}

export function normalizeReasoningEffortForModel(
  model: string | undefined,
  effort: LlmReasoningEffort | undefined
): LlmReasoningEffort | undefined {
  const capability = reasoningCapabilityForModel(model);
  if (!capability) return undefined;
  if (capability.provider === "deepseek") {
    // DeepSeek V4 exposes only three tiers: thinking OFF ("none"), "high", and "max". A sub-high
    // request (none/minimal/low/medium — including the app's "medium" DEFAULT) resolves to the FAST
    // "none" tier, NOT a silent upgrade to "high". "high" spends a long, unbounded hidden-reasoning
    // phase server-side before emitting any visible JSON; on a non-streaming whole-response await that
    // routinely blew the 60s request timeout (Green/Bear "timed out after 60s using DeepSeek"). High-
    // effort DeepSeek thinking is now OPT-IN: choose "high"/"xhigh"/"max" explicitly. The settings UI
    // resolves the displayed effort through this SAME function, so the effort shown is always exactly
    // the effort sent — the user can never select a value different from what actually runs.
    if (effort === "max" || effort === "xhigh") return "max";
    if (effort === "high") return "high";
    return "none";
  }
  return normalizeReasoningEffortForOptions(capability.options, effort);
}

export function isDisallowedInteractiveStrategyReasoningConfig(model: string | undefined, effort: LlmReasoningEffort | undefined): boolean {
  const normalized = normalizeReasoningEffortForModel(model, effort);
  return /^gpt-5\.5(?:$|[-.:_])/i.test((model ?? "").trim()) && normalized === "high";
}

export function interactiveStrategyReasoningEffort(model: string, effort: LlmReasoningEffort | undefined): LlmReasoningEffort | undefined {
  const normalized = normalizeReasoningEffortForModel(model, effort);
  if (!normalized) return undefined;
  return isDisallowedInteractiveStrategyReasoningConfig(model, normalized) ? "medium" : normalized;
}

/**
 * Extra output-token headroom for reasoning models (hidden reasoning tokens are billed against the
 * same completion cap as the visible answer). Originally OpenAI-only (Fable composite review
 * B/high/S: `withLlmRequestBounds` added this headroom ONLY in the `provider === 'openai'` branch,
 * so xAI/Gemini/Mistral/DeepSeek chat-completions calls kept the bare 1500-token cap even at
 * medium/high reasoning effort — a hard-thinking non-OpenAI call could spend its whole budget on
 * hidden reasoning tokens and truncate the visible JSON answer before it ever started). Covers every
 * effort level any provider's capability options expose (`none`/`minimal` need no extra headroom).
 */
const REASONING_TOKEN_BUDGET: Record<Exclude<LlmReasoningEffort, "none">, number> = {
  minimal: 1000,
  low: 2000,
  medium: 4000,
  high: 8000,
  xhigh: 12000,
  max: 16000
};

/** Extra visible-output headroom for a provider's reasoning effort, or 0 when the effort spends no
 *  hidden tokens against the completion cap ("none", or no reasoning capability at all). */
function reasoningTokenHeadroom(effort: LlmReasoningEffort | undefined): number {
  if (!effort || effort === "none") return 0;
  return REASONING_TOKEN_BUDGET[effort];
}

export const LLM_REQUEST_DEFAULTS = {
  deterministicTemperature: 0,
  maxOutputTokens: 1500,
  /**
   * Sampling temperature for the single Red Team reviewer (`debateProposal`). Composite review
   * B/medium/S: "everything runs at temperature 0 including red-teaming, so one greedy same-family
   * reviewer surfaces one failure mode." A non-zero adversary temperature widens the set of
   * objections a re-run could surface instead of always finding the exact same (or no) flaw.
   * Per-role sampling: the proposer (Bull/Green) keeps temperature 0 (deterministic, unaffected).
   */
  adversaryTemperature: 0.7
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

/**
 * Wall-clock cap for a strategy Green/Bear LLM call, widened for a thinking-enabled reasoning model.
 * A reasoning model that is ACTUALLY thinking (effort resolves to something other than "none") can
 * legitimately spend well past the 60s default generating hidden reasoning tokens before it emits the
 * visible JSON, so a non-streaming whole-response await would otherwise abort a call that was still
 * making progress (this is the DeepSeek "timed out after 60s" failure). Both bounds are env-tunable —
 * STRATEGY_LLM_TIMEOUT_MS for the base, STRATEGY_LLM_REASONING_TIMEOUT_MS for the thinking bound.
 * Trade-off: a longer bound holds the per-user run lock longer (see LLM_TIMEOUT_MS), so the widening
 * applies ONLY when the model is in a thinking mode the user explicitly opted into (never at the fast
 * default). A non-reasoning or thinking-off model keeps the base 60s bound unchanged.
 */
export function strategyLlmTimeoutMs(model: string | undefined, effort: LlmReasoningEffort | undefined): number {
  const base = Number(process.env.STRATEGY_LLM_TIMEOUT_MS) || LLM_TIMEOUT_MS;
  const normalized = normalizeReasoningEffortForModel(model, effort);
  const thinking = !!normalized && normalized !== "none";
  if (!thinking) return base;
  return Math.max(base, Number(process.env.STRATEGY_LLM_REASONING_TIMEOUT_MS) || 150_000);
}

/** The eventual result of an LLM call, reported once the request finally settles (fast OR late). */
export interface LlmCallOutcome {
  /** Wall-clock ms from request start to settle. */
  durationMs: number;
  /** True when it settled AFTER the soft timeout (i.e. the strategy tick had already given up on it). */
  late: boolean;
  ok: boolean;
  status?: number;
  error?: string;
  /** The eventual Response. On the LATE path the caller (which bailed at the soft timeout and never
   *  read the body) may read this to capture the reply for debugging. Absent when the request errored. */
  response?: Response;
}

/**
 * A strategy LLM fetch that CAPTURES latency and never severs a slow reply. It resolves with the
 * Response if it arrives within `softTimeoutMs`; otherwise it rejects with a TimeoutError — so the
 * caller's existing timeout/fallback path runs and the tick moves on — BUT the underlying request
 * keeps running (up to a generous `hardCapMs` leak backstop, default max(2×soft, 300s)) and its
 * eventual outcome (duration, status, and the late Response) is reported via `onOutcome`. This is what
 * lets us record how long a model like DeepSeek actually takes and keep the reply we already paid for,
 * instead of aborting at the wall and discarding the evidence. Unlike `llmFetch`, no soft-timeout
 * abort signal is attached to the fetch — only the hard cap.
 */
export function llmFetchCapturing(
  url: string,
  init: RequestInit,
  opts: { softTimeoutMs: number; hardCapMs?: number; onOutcome?: (outcome: LlmCallOutcome) => void }
): Promise<Response> {
  const started = Date.now();
  const softMs = opts.softTimeoutMs;
  const hardCap = Math.max(softMs, opts.hardCapMs ?? Math.max(softMs * 2, 300_000));
  const fetchPromise = fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(hardCap) });

  const emit = opts.onOutcome;
  if (emit) {
    fetchPromise.then(
      (response) => {
        const durationMs = Date.now() - started;
        emit({ durationMs, late: durationMs > softMs, ok: response.ok, status: response.status, response });
      },
      (error) => {
        const durationMs = Date.now() - started;
        emit({ durationMs, late: durationMs > softMs, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    );
  }

  let softTimer: ReturnType<typeof setTimeout> | undefined;
  const softTimeout = new Promise<never>((_, reject) => {
    softTimer = setTimeout(() => reject(new DOMException(`Strategy LLM soft timeout after ${softMs}ms`, "TimeoutError")), softMs);
  });
  // Clear the soft timer once the fetch settles so it can't reject a race nobody is watching anymore.
  const clear = () => { if (softTimer) clearTimeout(softTimer); };
  fetchPromise.then(clear, clear);
  return Promise.race([fetchPromise, softTimeout]);
}

/** HTTP statuses worth failing over to another provider (rate limit / transient upstream errors). */
const RETRYABLE_LLM_STATUSES = new Set([429, 500, 502, 503, 504]);
export function isRetryableLlmStatus(status: number): boolean {
  return RETRYABLE_LLM_STATUSES.has(status);
}
/** True for timeouts (AbortSignal.timeout → AbortError/TimeoutError) and transient network errors. */
export function isRetryableLlmError(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  if (name === "AbortError" || name === "TimeoutError") return true;
  const msg = String((error as { message?: string } | null)?.message ?? error ?? "");
  return /abort|timed? ?out|timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network|fetch failed/i.test(msg);
}

export interface LlmRetryOptions {
  /** Total attempts INCLUDING the first (default 2, clamped 1–3). Keep small: the adversary runs
   *  inside the per-user scheduler lock — aggressive retries starve the scheduler and defeat the
   *  reason the hard per-call timeout exists (design doc §4.3). */
  attempts?: number;
  /** Base backoff before attempt N+1: `baseDelayMs * 2^N` (default 500ms — total added wall-clock
   *  stays trivially small relative to the per-attempt timeout). */
  baseDelayMs?: number;
  /** Per-attempt timeout; each attempt gets its OWN AbortSignal so a retry never inherits an
   *  already-expiring signal. Defaults to LLM_TIMEOUT_MS via llmFetch. */
  timeoutMs?: number;
  /** Observability hook — called before each retry with what triggered it. */
  onRetry?: (info: { attempt: number; status?: number; error?: unknown }) => void;
}

/**
 * `llmFetch` with a small bounded retry on TRANSIENT failures only (HTTP 429/5xx per
 * `isRetryableLlmStatus`, and timeouts/socket errors per `isRetryableLlmError`) — design doc §4.3
 * for the single Red Team reviewer (the Green/Bull path keeps its own explicit
 * `policy.llmFallbackModels` failover chain instead). Non-transient failures (4xx, schema errors)
 * return/throw immediately. There is deliberately NO hidden model/provider failover here (R11):
 * a failed reviewer declares itself unavailable and the caller fails closed to human review.
 */
export async function fetchLlmWithRetry(
  url: string,
  init: RequestInit = {},
  options: LlmRetryOptions = {}
): Promise<Response> {
  const attempts = Math.max(1, Math.min(3, options.attempts ?? 2));
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 500);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    // Fresh per-attempt signal: reusing one AbortSignal.timeout across attempts would hand the
    // retry a clock that already ran during attempt 1. A caller-supplied `init.signal` is
    // respected as-is (caller-managed lifetime).
    const attemptInit: RequestInit = {
      ...init,
      signal: init.signal ?? (options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined)
    };
    try {
      const response = await llmFetch(url, attemptInit);
      if (attempt < attempts && isRetryableLlmStatus(response.status)) {
        options.onRetry?.({ attempt, status: response.status });
        await response.text().catch(() => ""); // drain so the socket can be reused
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)));
        continue;
      }
      return response;
    } catch (error) {
      if (attempt < attempts && isRetryableLlmError(error)) {
        lastError = error;
        options.onRetry?.({ attempt, error });
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)));
        continue;
      }
      throw error;
    }
  }
  throw lastError ?? new Error("LLM request failed after retries.");
}

export const LLM_OUTPUT_TOKEN_CAPS = {
  strategyProposal: LLM_REQUEST_DEFAULTS.maxOutputTokens,
  strategyTuning: LLM_REQUEST_DEFAULTS.maxOutputTokens,
  /**
   * The single Red Team reviewer (docs/single-adversary-consolidation.md §7). Replaces the former
   * duplicate `strategyCritique` (in-flow Bear, deleted) and `redTeamDebate` caps — one adversary,
   * one cap.
   */
  adversaryReview: LLM_REQUEST_DEFAULTS.maxOutputTokens,
  postMortemReflection: LLM_REQUEST_DEFAULTS.maxOutputTokens,
  proposalRevalidation: LLM_REQUEST_DEFAULTS.maxOutputTokens,
  // Small — a structured-output extraction of a handful of {kind,subject,value,symbol} candidates
  // from one chat message, not a proposal/critique. Kept well below the shared default so a
  // pathological reply can't run up cost; the extractor also has an offline regex fallback.
  salienceExtraction: 400,
  // Once-per-day structured review of the learning store — dozens of per-item verdicts each with a
  // reasoning string, so it gets the shared default rather than a tight cap.
  learningReview: LLM_REQUEST_DEFAULTS.maxOutputTokens
} as const;

type RequestBounds = {
  maxOutputTokens: number;
  /** The target model — determines whether provider-specific reasoning/thinking controls apply. */
  model: string;
  temperature?: number;
  /** Provider-specific reasoning/thinking effort. Defaults to "medium"; ignored by unsupported models. */
  reasoningEffort?: LlmReasoningEffort;
};

/**
 * Floor on Anthropic's REQUIRED `max_tokens`. Anthropic bills only tokens actually emitted, so a
 * generous ceiling has no cost downside but prevents a long structured (tool-use) JSON answer from
 * being truncated mid-object the way a tight per-call cap (e.g. 1500) would. Visible-output caps for
 * OpenAI-compatible providers are unaffected.
 */
const ANTHROPIC_MIN_MAX_TOKENS = 4096;

export function withLlmRequestBounds<T extends Record<string, unknown>>(
  body: T,
  transport: LlmTransport,
  bounds: RequestBounds
): T & Record<string, unknown> {
  const capability = reasoningCapabilityForModel(bounds.model);
  const normalizedEffort = normalizeReasoningEffortForModel(bounds.model, bounds.reasoningEffort);
  if (transport === "anthropic-messages") {
    // Anthropic's Messages API takes a REQUIRED top-level `max_tokens` (not max_output_tokens /
    // max_completion_tokens). Newer Claude adaptive-thinking models reject non-default sampling knobs,
    // so omit temperature when adaptive thinking is active.
    const base = { ...body, max_tokens: Math.max(bounds.maxOutputTokens, ANTHROPIC_MIN_MAX_TOKENS) };
    if (capability?.provider === "anthropic" && normalizedEffort) {
      return { ...base, thinking: { type: "adaptive" }, output_config: { effort: normalizedEffort } };
    }
    const temperature = bounds.temperature ?? LLM_REQUEST_DEFAULTS.deterministicTemperature;
    return { ...base, temperature };
  }

  if (capability?.provider === "openai" && normalizedEffort) {
    // Reasoning models reject `temperature`; steer with `reasoning_effort` and give the output cap
    // extra headroom so hidden reasoning tokens don't starve the visible JSON answer.
    const effort = normalizedEffort as "low" | "medium" | "high";
    const maxOutputTokens = bounds.maxOutputTokens + reasoningTokenHeadroom(effort);
    if (transport === "responses") {
      return { ...body, max_output_tokens: maxOutputTokens, reasoning: { effort } };
    }
    return { ...body, max_completion_tokens: maxOutputTokens, reasoning_effort: effort };
  }

  const temperature = bounds.temperature ?? LLM_REQUEST_DEFAULTS.deterministicTemperature;
  if (transport === "responses") {
    return { ...body, max_output_tokens: bounds.maxOutputTokens, temperature };
  }
  if (capability && normalizedEffort) {
    // Same headroom rationale as the OpenAI branch above, extended to every other
    // reasoning-capable chat-completions provider (xAI, Gemini, Mistral, DeepSeek): these all bill
    // hidden "thinking"/reasoning tokens against the SAME `max_completion_tokens` cap as the visible
    // JSON answer, so a bare 1500-token cap at medium/high effort starves the visible output before
    // it can even start (composite review B/high/S — this was previously OpenAI-only).
    const maxCompletionTokens = bounds.maxOutputTokens + reasoningTokenHeadroom(normalizedEffort);
    if (capability.provider === "deepseek") {
      const deepSeekThinking =
        normalizedEffort === "none"
          ? { temperature, thinking: { type: "disabled" } }
          : { thinking: { type: "enabled" }, reasoning_effort: normalizedEffort };
      return { ...body, max_completion_tokens: maxCompletionTokens, ...deepSeekThinking };
    }
    const providerReasoning =
      capability.provider === "mistral" && normalizedEffort !== "none"
        ? { reasoning_effort: normalizedEffort, prompt_mode: "reasoning" }
        : { reasoning_effort: normalizedEffort };
    return { ...body, max_completion_tokens: maxCompletionTokens, temperature, ...providerReasoning };
  }
  return { ...body, max_completion_tokens: bounds.maxOutputTokens, temperature };
}
