// Canonical model identity — the single source of truth for collapsing a route-qualified
// model ID onto the bare catalog name.
//
// Under universal OpenRouter routing, an LLM call records a route-qualified model
// (`anthropic/claude-sonnet-5`, `openai/gpt-4o`), while the same model called directly — and
// the offline benchmark JSON and the model-picker catalog — uses the bare name
// (`claude-sonnet-5`, `gpt-4o`). Everything that keys on the model (cost, latency, realized-P&L
// / win-rate benchmark, reviewer efficacy, the Usage cost page) must canonicalize to the bare
// name so live, historical, and benchmark stats align across the routing cutover.
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

  // Strip any vendor routing prefix (e.g. "openrouter/", "anthropic/", "x-ai/", "google/", "meta-llama/", etc.)
  if (name.includes("/")) {
    name = name.split("/").pop() || name;
  }
  name = name.replace(/^~anthropic\//i, "").replace(/^xai\//i, "").replace(/^meta-llama\//i, "");

  const lower = name.toLowerCase();

  // Anthropic family
  if (/sonnet/i.test(lower)) return "claude-sonnet-latest";
  if (/haiku/i.test(lower)) return "claude-haiku-latest";
  if (/opus/i.test(lower)) return "claude-opus-latest";
  if (/fable/i.test(lower)) return "claude-fable-latest";

  // xAI family
  if (/grok.*build|build/i.test(lower) && /grok/i.test(lower)) return "grok-build-latest";
  if (/grok/i.test(lower)) return "grok-latest";

  // Google Gemini family
  if (/gemini.*flash.*lite|flash.*lite/i.test(lower)) return "gemini-flash-lite-latest";
  if (/gemini.*flash|flash/i.test(lower)) return "gemini-flash-latest";
  if (/gemini.*pro|pro/i.test(lower)) return "gemini-pro-latest";

  // DeepSeek family
  if (/deepseek.*r1|r1|reasoner/i.test(lower)) return "deepseek-r1-latest";
  if (/deepseek.*flash|v4-flash|chat/i.test(lower)) return "deepseek-flash-latest";
  if (/deepseek.*pro|v4-pro/i.test(lower)) return "deepseek-pro-latest";

  // Mistral family
  if (/mistral.*small|small/i.test(lower)) return "mistral-small-latest";
  if (/mistral.*medium|medium/i.test(lower)) return "mistral-medium-latest";
  if (/mistral.*large|large/i.test(lower)) return "mistral-large-latest";

  // Meta family
  if (/llama/i.test(lower)) return "llama-70b-latest";

  // OpenAI family
  if (/sol/i.test(lower)) return "gpt-sol-latest";
  if (/terra/i.test(lower)) return "gpt-terra-latest";
  if (/luna/i.test(lower)) return "gpt-luna-latest";
  if (/mini/i.test(lower) && !/gpt-4o/i.test(lower)) return "gpt-mini-latest";
  if (/nano/i.test(lower)) return "gpt-nano-latest";
  if (/gpt-4o-mini/i.test(lower)) return "gpt-mini-latest";
  if (/gpt-4o/i.test(lower)) return "gpt-4o-latest";

  return name;
}
