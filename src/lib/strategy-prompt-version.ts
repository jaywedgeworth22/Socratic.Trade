/**
 * Single stampable version for the Bull/Bear/Red-Team strategy prompts.
 *
 * Bump this string whenever the strategy's prompt semantics change so Langfuse traces can be
 * filtered/compared across prompt revisions (it's attached to every traced generation's
 * `metadata.promptVersion`). This lives in its own tiny module — rather than in `strategy.ts` — so
 * both `strategy.ts` (bull/bear) and `red-team.ts` (debate) can import it without a circular
 * dependency (`strategy.ts` imports `red-team.ts`).
 *
 * This is a lightweight stamping constant only; full prompt extraction/versioning is a separate
 * workstream and intentionally out of scope here.
 */
export const STRATEGY_PROMPT_VERSION = "agentic-strategy@0.1.0";
