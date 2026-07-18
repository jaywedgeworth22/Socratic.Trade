// Model catalog shape. These types formerly lived in app/ui/model-picker.tsx; that custom
// dropdown component was retired 2026-07-17 (zero importers — the console assistant uses its own
// picker), so the still-used type surface moved here, the catalog's own home.
export type PickerProviderId =
  | "openai"
  | "anthropic"
  | "xai"
  | "gemini"
  | "mistral"
  | "deepseek"
  | "openrouter"
  | "offline";

export interface ModelOption {
  value: string;
  label: string;
  tier: "" | "$" | "$$" | "$$$";
  recommendedGreen?: boolean;
  recommendedRed?: boolean;
}

export interface ModelGroup {
  provider: PickerProviderId;
  label: string;
  options: ModelOption[];
}

export const CUSTOM_MODEL_ID_SEED = "custom-model-id";

/**
 * Sentinel model id meaning "rotate through all eligible curated models — a different one each
 * run" (comparative-measurement option for accruing attributed history across models on any real
 * broker account). Persisted as-is on policy.llmModel / policy.redTeamLlmModel; the strategy
 * run substitutes the concrete round-robin pick at run start (src/lib/model-rotation.ts — models
 * with no resolvable provider key are skipped). Keep the literal in sync with
 * LLM_MODEL_ROTATION_SENTINEL in src/lib/llm-request.ts.
 */
export const ROTATE_ALL_MODELS_ID = "__rotate__";
export const ROTATE_ALL_MODELS_LABEL = "Rotate eligible models (comparative measurement)";

// Label + recommendation conventions (owner rulings 2026-07-08 + 2026-07-09; this is the ONLY
// catalog copy since the Settings models card was retired 2026-07-10 — the Framework page and
// the Coach picker both read it): descriptors are ROLE-NEUTRAL noun phrases (this catalog feeds
// both the Green/proposer and Red/reviewer pickers — no "critique"/"review" in a label).
//
// RECOMMENDATION POLICY: established models use substantive benchmark output + realized history,
// never schema-validity alone. A newly released model may carry a PROVISIONAL role prior when its
// official tier/price clearly replaces an older full-size model; source-value, model-attribution,
// and rotation history must re-adjudicate that prior as real outcomes accrue. The GPT-5.6 Terra
// Green and Sol Red flags below are provisional capability/price priors, not empirical claims.
//
// TWO EVIDENCE TRAPS the previous flags fell into — do not repeat them:
// 1) DEGENERATE-BENCHMARK TRAP: the benchmark ranking (schema-valid rate, ties by latency)
//    crowns instant empty-valid outputs. deepseek-v4-pro/-flash "won" Green with 8-token
//    `{"proposals":[]}` no-ops x3; claude-haiku-4-5 "won" Red with 33 flat tokens and ZERO
//    thinking. Never flag from rank — check proposalCount/survivors plus token accounting
//    (docs/benchmarks/2026-07-08-llm-model-benchmark.{md,json}). The Red schema captures no
//    rejection reasoning, so a diligent full veto and a lazy no-op are byte-identical; only
//    reasoning-token spend distinguishes them.
// 2) INCUMBENT-CIRCULARITY TRAP: realized records (gemini-3.5-flash bear 46/46 + bull 27/0,
//    gpt-5.4-mini bull 22/2 + bear 18/1, deepseek-v4-pro bear 17/3) exist because those models
//    held the prior rec flags, and they count PARSE-LEVEL successes — the Bear parse
//    (`parsed.proposals ?? []`) reads a wrong-shaped or empty output as a silent zero-survivor
//    "success". The benchmark proved deepseek-v4-pro Red is 0% schema-valid (wrong keys:
//    approvedProposals/survivingProposals), so its 17/3 bear record is untrustworthy —
//    recommendedRed removed 2026-07-09. Harden the Bear parse to treat unknown envelopes as
//    PARSE FAILURE before ever seating a DeepSeek model as Red.
//
// Current established flags (2026-07-09):
// - GREEN: claude-haiku-4-5 (benchmark: 3 proposals every round, 89% bracket population, 8.9s
//   cold, $0.0067 — volume/brackets can't be faked by empty JSON; realized history pending the
//   Anthropic key cap lifting 2026-08-01) and gemini-3.5-flash (substantive all rounds, 75%
//   brackets, plus the only clean realized bull record 27/0; honest cost = 27s cold p50).
// - RED: gemini-3.1-pro-preview (owner ruling 2026-07-09; independently defensible — 3/3
//   reliable, 100% schema-valid, ~300-600 hidden thinking tokens per round before each verdict;
//   its all-veto rounds are undecidable veto-vs-no-op by the benchmark's structural limit, not
//   evidence of breakage, and its Green rounds show it is not a lazy model) and claude-sonnet-5
//   (the only model besides claude-opus-4-8 with inspectable per-proposal review work EVERY
//   round — survivor re-emitted with rationale, 434-559 visible tokens, 7.1s, $0.0136; zero
//   realized calls = the Anthropic key cap, never a model quality).
// - Removed 2026-07-09: deepseek-v4-pro Red (actively contradicted — trap 2); gpt-5.4-mini
//   Green+Red (Green: observed 1-in-3 reasoning-burnout empty response at 43.9s/5500 tok and
//   24-50s latency on an RPM=2 key; Red: unverifiable all-veto; both records circular — still a
//   capable model, stays in rotation and can earn flags back); gemini-3.5-flash Red (crowding,
//   not contradiction — weaker than sonnet's verifiable review work, and two Gemini Red chips
//   would concentrate provider risk; it is the natural interim Red fallback).
// - Added provisionally 2026-07-13: GPT-5.6 Terra Green (balanced tier, Medium effort) and Sol Red
//   (frontier tier, High effort). Luna is the high-volume/Coach tier; Mini/Nano remain because Luna
//   is newer but costs more, while full GPT-5.4/5.5 were removed from curated pickers as same-price
//   predecessors to Terra/Sol. Stored/custom legacy ids remain callable for backward compatibility.
//
// Standing rulings preserved: key-level quota/rate limits (the 2026-07 Anthropic usage cap; the
// OpenAI RPM=2 429s dominating gpt-5.5's bull record and gpt-5.4's benchmark Red row) are
// OWNER-ADJUSTABLE account settings, NOT model qualities — never hold them against a model here.
// Benchmark caveats travel with any citation: single input pack, 3 rounds, rounds 2+ cache-warm,
// no response bodies persisted (next run must capture bodies or a rejection-reasoning field so
// veto-vs-no-op becomes decidable). Re-derive flags as rotation history accrues.
export const CURATED_LLM_MODEL_GROUPS: ModelGroup[] = [
  {
    provider: "openai",
    label: "OpenAI",
    options: [
      { value: "gpt-5.4-nano", label: "gpt-5.4-nano - lowest cost OpenAI", tier: "$" },
      { value: "gpt-5.4-mini", label: "gpt-5.4-mini - proven low-cost OpenAI", tier: "$$" },
      { value: "gpt-5.6-luna", label: "gpt-5.6-luna - current cost-sensitive tier", tier: "$$" },
      { value: "gpt-5.6-terra", label: "gpt-5.6-terra - balanced current-generation analysis", tier: "$$$", recommendedGreen: true },
      { value: "gpt-5.6-sol", label: "gpt-5.6-sol - frontier professional reasoning", tier: "$$$", recommendedRed: true }
    ]
  },
  {
    provider: "anthropic",
    label: "Anthropic",
    options: [
      { value: "claude-haiku-4-5", label: "claude-haiku-4-5 - fast low-cost Claude", tier: "$", recommendedGreen: true },
      { value: "claude-sonnet-5", label: "claude-sonnet-5 - balanced Claude analysis", tier: "$$", recommendedRed: true },
      { value: "claude-opus-4-8", label: "claude-opus-4-8 - premium Claude reasoning", tier: "$$$" },
      { value: "claude-fable-5", label: "claude-fable-5 - most capable Claude", tier: "$$$" }
    ]
  },
  {
    provider: "xai",
    label: "xAI",
    options: [
      { value: "grok-build-0.1", label: "grok-build-0.1 - coding specialist", tier: "$" },
      { value: "grok-4.3", label: "grok-4.3 - default Grok analysis", tier: "$$" }
    ]
  },
  {
    provider: "gemini",
    label: "Google",
    options: [
      { value: "gemini-3.1-flash-lite", label: "gemini-3.1-flash-lite - low-cost Gemini", tier: "$" },
      { value: "gemini-3.5-flash", label: "gemini-3.5-flash - stable flagship Flash", tier: "$$", recommendedGreen: true },
      { value: "gemini-3.1-pro-preview", label: "gemini-3.1-pro-preview - deepest Gemini reasoning", tier: "$$$", recommendedRed: true }
    ]
  },
  {
    provider: "mistral",
    label: "Mistral",
    options: [
      { value: "mistral-small-2603", label: "mistral-small-2603 - low-cost Mistral Small 4", tier: "$" },
      { value: "mistral-medium-3-5", label: "mistral-medium-3-5 - frontier Mistral Medium", tier: "$$" }
    ]
  },
  {
    provider: "deepseek",
    label: "DeepSeek",
    options: [
      { value: "deepseek-v4-flash", label: "deepseek-v4-flash - fast DeepSeek V4", tier: "$" },
      { value: "deepseek-v4-pro", label: "deepseek-v4-pro - stronger DeepSeek V4", tier: "$$" }
    ]
  },
  {
    provider: "openrouter",
    label: "OpenRouter",
    options: [
      { value: "openrouter/openai/gpt-4o", label: "OpenRouter GPT-4o", tier: "$$$" },
      { value: "openrouter/openai/gpt-4o-mini", label: "OpenRouter GPT-4o-mini", tier: "$" },
      { value: "openrouter/anthropic/claude-3.5-sonnet", label: "OpenRouter Claude 3.5 Sonnet", tier: "$$$" },
      { value: "openrouter/anthropic/claude-3-5-haiku", label: "OpenRouter Claude 3.5 Haiku", tier: "$" },
      { value: "openrouter/google/gemini-2.5-pro", label: "OpenRouter Gemini 2.5 Pro", tier: "$$$" },
      { value: "openrouter/google/gemini-2.5-flash", label: "OpenRouter Gemini 2.5 Flash", tier: "$" },
      { value: "openrouter/meta-llama/llama-3.3-70b-instruct", label: "OpenRouter Llama 3.3 70B", tier: "$$" },
      { value: "openrouter/deepseek/deepseek-r1", label: "OpenRouter DeepSeek R1", tier: "$$$" }
    ]
  }
];

export const CURATED_LLM_MODEL_IDS = CURATED_LLM_MODEL_GROUPS.flatMap((group) => group.options.map((option) => option.value));

export const CHAT_MODEL_GROUPS: ModelGroup[] = [
  {
    provider: "offline",
    label: "Offline",
    options: [
      { value: "mock", label: "Mock - deterministic, no key", tier: "" },
      { value: "custom", label: "Custom Model ID...", tier: "" }
    ]
  },
  ...CURATED_LLM_MODEL_GROUPS
];
