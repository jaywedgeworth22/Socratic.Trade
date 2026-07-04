# 2026-07-04 — Wave-2 reflection lane: decomposed lessons + regime-conditioned retrieval + per-account reflection keying

Branch `claude/w2-reflection-decompose`, worktree `~/apps/trading-wt-w2-reflection`, base
`origin/claude/w2-episodic-retrieval` (STACKED — lands via the Wave-2 landing train after its base).
Push-only lane: no PR, no `land.sh`.

## Summary

Implements three composite-expert-review section-A items
(`docs/reviews/2026-07-04-composite-expert-review.md`, in the review branch):

1. **Decompose reflection into structured, regime/thesis-conditioned, retrievable lessons**
   ([Both], high/M). `generateReflectionSummary` used to write ONE <=130-word per-account blob
   injected into every Bull prompt regardless of regime. Now `writeDecomposedLessons`
   (`src/lib/post-mortem.ts`) deterministically groups closed lots into (thesisTag x regime)
   buckets and writes one DISCRETE lesson row per bucket into `learned_context` with new
   conditioning tag columns `{regime, thesis_tag, dominant_factor}` (dominant factor = modal
   entry factor across the bucket's lots), carrying realized win-rate / avg return / avg MAE /
   avg MFE / capturePct in the value text. Each written/updated lesson is ALSO embedded as a
   `doc_type="lesson"` vector (`source="reflection-lesson"`, dedupKeyPrefix `lesson`) — the
   episodic retrieval pass from the base lane already consumes `doc_type 'lesson'`
   (`EPISODIC_DOC_TYPES` in `experience-memory.ts`), so lessons become decision-time retrievable
   with zero changes to that lane's code. Emission is gated on `MIN_LOTS_FOR_LESSON` (5) per
   regime bucket, with a REGIME-AGNOSTIC fallback row (regime=null, subject
   `lesson:<thesis>@all-regimes`) when a thesis has total sample but every regime bucket is thin.
   Reconcile-on-write: identical stats → no rewrite/no re-embed; changed stats → supersede-in-place.
   Rows are written directly via `insertLearnedContext` (NOT `ingestLearned`): these are
   deterministic system-computed stats over the owner's own closed lots — the fail-closed
   classifier exists for free-text LLM/chat output and would misread the numeric content as
   risk-adjacent. Fact-tier, advisory only; nothing feeds sizing/policy.
   **Blob demotion:** `resolveReflectionForPrompt` — once ANY live lesson rows exist for the user,
   the free-text blob leaves the Bull system prompt (replaced by the static
   `REFLECTION_DEMOTED_NOTE` pointer, cache-stable); with ZERO structured lessons the per-account
   blob remains the fallback so a young account still gets its reflection.

2. **Regime/thesis-conditioned retrieval.** `retrieveLearnedContext`
   (`src/lib/learned-context/store.ts`) now USES its previously-ignored `regime` arg as a ranking
   BOOST (never a hard filter): +2 current-regime match, -1 mismatch, +1 candidate-thesis match
   (new `options.thesisTags`), recency as tiebreak. Mismatched-regime rows are still served,
   LABELED `(learned in <regime>)` so the model can discount them itself. The strategy.ts
   learnedContext injection block threads the current run regime (cached `fetchMacroData` +
   `determineMarketRegime`) and the account's realized thesis tags (from `getThesisScorecard` —
   exactly the buckets lessons are keyed by) into the call.

3. **Reflection keying + history** ([Both], medium/M). Reflections were keyed at USER level
   (signature `reflection_signature:<userId>`, output in `user_settings.reflection_summary`) —
   two accounts clobbered each other and wrongly suppressed regeneration. Now: signature key is
   `reflection_signature:<userId>:<accountNumber>` (`reflectionSignatureKey`), and the summary is
   an APPEND-ONLY versioned row in the new `reflection_versions` table keyed
   (user_id, account_number) with monotonic `version` and the `input_stats_hash` (the same
   signature the regeneration gate uses). CRUD in `db-learning.ts`
   (`appendReflectionVersion` / `getLatestReflectionVersion` / `listReflectionVersions`).
   Readers updated: `proposeTrades` (via `resolveReflectionForPrompt(userId, accountNumber)`) and
   the chat orchestrator's `getReflection` tool (latest version for the active account).
   The console current-vs-previous diff with edit/veto is deferred (see Follow-ups).

## Why

Both expert panels independently flagged the reflection blob as lossy, drift-prone,
cache-busting, and regime-blind (composite review executive summary item 3), and the per-account
clobber as a correctness bug. This lane closes the reflection third of the Wave-2 memory/RAG
critical path; the episodic base lane supplies the retrieval surface the lessons ride on.

## Files

- `src/lib/post-mortem.ts` — per-account signature key; append-only version write;
  `writeDecomposedLessons` + `buildLessonBuckets` + `lessonSubject` + `buildLessonDocument` +
  `resolveReflectionForPrompt` + `REFLECTION_DEMOTED_NOTE` + `MIN_LOTS_FOR_LESSON` +
  `reflectionSignatureKey` (all exported for tests/consumers); lesson write call wired into
  `generateReflectionSummary` (deterministic, pre-LLM, best-effort).
- `src/lib/learned-context/store.ts` — `retrieveLearnedContext` regime/thesis boost + mismatch
  labels (`options.thesisTags` additive).
- `src/lib/db.ts` — `learned_context` gains nullable `regime`/`thesis_tag`/`dominant_factor`
  (CREATE TABLE + guarded ALTERs); new `reflection_versions` table + index.
- `src/lib/db-learning.ts` — raw-row/map/insert for the three tag columns;
  `countLiveLessonRows`; `reflection_versions` CRUD.
- `src/lib/types.ts` — optional `regime`/`thesisTag`/`dominantFactor` on `LearnedContextRow`.
- `src/lib/strategy.ts` — learnedContext injection block threads regime + candidate thesis tags;
  `proposeTrades` reflection read switched to `resolveReflectionForPrompt` (demotion + per-account).
- `src/lib/chat/orchestrator.ts` — `getReflection` reads the latest per-account version.
- `src/lib/account-deletion.ts` — `reflection_versions` added to `DELETE_TABLES_BY_USER_ID`
  (the account-deletion coverage guard test caught the new user-scoped table).
- `test/reflection-decompose.test.ts` — NEW: lessons written+embedded (tags, stats, doc_type
  'lesson' metadata), min-sample gate + regime-agnostic fallback, idempotence + supersede,
  embed-failure isolation, regime boost ordering + mismatch labels + thesis boost, blob
  demotion/fallback, per-account keying + append-only history regression, signature-key format.
- `test/post-mortem.test.ts` — assertions moved from `user_settings.reflection_summary` to
  `getLatestReflectionVersion`.

## Verification

Run in `~/apps/trading-wt-w2-reflection`, in order:

- `npm run lint` — 0 errors (308 pre-existing grandfathered warnings).
- `npx tsc --noEmit` — clean.
- `npm test` — full suite green (counts in STATUS.md / commit message).
- `npm run build` — green.

## Follow-ups

- Console surface for reflection version history (current-vs-previous diff, edit/veto routing an
  owner edit through coaching-becomes-learning) — review item's UI half, deferred.
- Rank-by-relevance beyond regime/thesis (symbol > thesis > regime > confidence > recency,
  composite review "Rank learned-context retrieval by relevance") — separate item, not this lane.
- Regime stamping for OTHER learned-context producers (chat salience, track-record facts) — the
  column exists; producers that know their regime should start writing it.
- Old `user_settings.reflection_summary` rows and `reflection_signature:<userId>` internal keys
  are orphaned (unread) after this lane; harmless, cleanable in a later sweep.
