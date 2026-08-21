// Canonical model identity — the single source of truth for collapsing a route-qualified
// or versioned model ID onto the catalog family name.
//
// Under universal OpenRouter routing, an LLM call records a route-qualified / dated slug
// (`google/gemini-3.7-flash`, `anthropic/claude-sonnet-4-6`), while the picker catalog and
// offline benchmark JSON use the family id (`gemini-flash-latest`, `claude-sonnet-5`).
// Everything that keys on the model (cost, latency, realized-P&L / win-rate, reviewer
// efficacy, Usage, Results) must collapse every version of a line onto that family so
// live, historical, and benchmark stats do not fragment (gemini-3.7-flash + gemini-flash-latest
// are one Flash row; every Opus is one Opus row; every Sonnet is one Sonnet row).
//
// This consolidates two previously-duplicated definitions: `cleanModelId` (src/lib/model-stats.ts,
// AG / PR #1703) and `canonicalModelId` (app/admin/llm-usage/model-merge.ts, PR #1716). The logic
// below is AG's verified `cleanModelId` behavior verbatim (last path segment, case-preserving),
// so importing it here is a no-op behavior change for the benchmark stats.
//
// Assumption (verified against app/ui/llm-model-catalog.ts): catalog model names are
// vendor-unique — no two distinct models share a bare name — so taking the last `/` segment only
// ever unifies the same model across routes, never merges two different models. If the catalog
// ever gains a cross-vendor bare-name collision, harden this to strip only the known OpenRouter
// vendor prefixes (anthropic/openai/xai/google/mistralai/deepseek + the openrouter/ meta-prefix)
// rather than any slash.

/** Bare catalog identity for a (possibly route-qualified) model id. Empty string for null/blank.
 *  Case-preserving: model ids are conventionally lowercase, and the benchmark/catalog lookup keys
 *  match case, so this must not lowercase. */
export function canonicalModelId(model: string | null | undefined): string {
  if (!model) return "";
  let name = model.trim();

  // Strip any vendor routing prefix (e.g. "openrouter/", "~anthropic/", "x-ai/", "google/", "meta-llama/", etc.)
  name = name.replace(/^~/, "");
  if (name.includes("/")) {
    name = name.split("/").pop() || name;
  }
  name = name.replace(/^~/, "").replace(/^xai\//i, "").replace(/^meta-llama\//i, "").replace(/^moonshotai\//i, "");

  const lower = name.toLowerCase();

  // Anthropic family
  if (/claude.*sonnet/i.test(lower)) return "claude-sonnet-5";
  if (/claude.*haiku/i.test(lower)) return "claude-haiku-4.5";
  if (/claude.*opus/i.test(lower)) return "claude-opus-5";
  if (/claude.*fable/i.test(lower)) return "claude-fable-5";

  // xAI family
  if (/grok.*build/i.test(lower)) return "grok-build-0.1";
  if (/grok/i.test(lower)) return "grok-4.5";

  // Google Gemini family
  if (/gemini.*flash.*lite/i.test(lower)) return "gemini-flash-lite-latest";
  if (/gemini.*flash/i.test(lower)) return "gemini-flash-latest";
  if (/gemini.*pro/i.test(lower)) return "gemini-pro-latest";

  // DeepSeek family
  if (/deepseek.*(r1|reasoner)/i.test(lower)) return "deepseek-reasoner";
  if (/deepseek.*(flash|chat)/i.test(lower)) return "deepseek-v4-flash";
  if (/deepseek.*pro/i.test(lower)) return "deepseek-v4-pro";

  // Mistral family
  if (/mistral.*small/i.test(lower)) return "mistral-small-latest";
  if (/mistral.*medium/i.test(lower)) return "mistral-medium-latest";
  if (/mistral.*large/i.test(lower)) return "mistral-large-latest";

  // Moonshot AI family
  if (/(kimi|moonshot)/i.test(lower)) return "kimi-latest";

  // Meta family
  if (/llama/i.test(lower)) return "llama-3.3-70b-instruct";

  // OpenAI family
  if (/gpt.*sol/i.test(lower)) return "gpt-5.6-sol";
  if (/gpt.*terra/i.test(lower)) return "gpt-5.6-terra";
  if (/gpt.*luna/i.test(lower)) return "gpt-5.6-luna";
  if (/gpt.*mini/i.test(lower) && !/gpt-4o/i.test(lower)) return "gpt-5.4-mini";
  if (/gpt.*nano/i.test(lower)) return "gpt-5.4-nano";
  if (/gpt-4o-mini/i.test(lower)) return "gpt-5.4-mini";
  if (/gpt-4o/i.test(lower)) return "gpt-4o";

  return name;
}
