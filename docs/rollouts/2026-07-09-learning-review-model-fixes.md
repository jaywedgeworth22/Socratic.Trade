# 2026-07-09 — Daily learning-review: no hidden model default, decide-by-default, user-level, renamed (MONET)

## Summary

Owner-directed refinements to the daily learning-review feature (#1116), plus two questions
answered by investigation:

1. **No hidden model default / no silent substitution.** "Blank should not equal Fable, and
   the whole app should never do hidden failovers or hidden backups — it should just require a
   model be chosen." The learning-review model was `unset → claude-fable-5` (a hidden fallback
   in code + a redundant `"" = default (claude-fable-5)` option in the dropdown). Now:
   - `DEFAULT_POLICY.learningReviewModel = "claude-fable-5"` — a **real, explicit** default value
     shown selected in the UI (owner: keep Fable as the default *choice*, just not a
     blank-means-Fable indirection).
   - The blank option is gone from the dropdown; the field always holds a chosen model.
   - The server no longer does `|| LEARNING_REVIEW_MODEL_DEFAULT`; if the model is somehow blank
     it **skips with reason `"no-model"`** rather than quietly picking one. The
     `LEARNING_REVIEW_MODEL_DEFAULT` constant (the old fallback) was removed.
   - App-wide audit for other hidden decision-model defaults: none live. `db.ts:377` is an
     immutable v15 migration that preserved deleted red-team behavior (not a runtime default);
     `app/ui/llm-model-catalog.ts` `DEFAULT_LLM_MODEL` is unused dead code from the removed glass
     dashboard; `vector-db.ts`'s rerank-2.5 is RAG infra (env-only, no settings surface). Flagged
     to owner, not changed.
2. **Decide is the default mode.** `DEFAULT_POLICY.learningReviewMode` `"annotate" → "decide"`;
   the card + server fallback now read "decide unless explicitly annotate". (Feature is still OFF
   by default — nothing runs until enabled; when enabled, it applies verdicts by default.)
3. **Renamed "Reviewer model" → "Learning-review model"** — the Red Team is now called
   "Reviewer", so the old label collided. Field label, hint, toast, and comments updated.
4. **Only run when there's something new to review (don't waste calls).** The review already
   skipped the LLM call when there were zero items, but the learned-facts window is a rolling
   7 days — so the same unchanged facts were re-sent to the model every day. Added a content
   fingerprint (`reviewFingerprint`): the review now skips with reason `"unchanged"` (no LLM
   call) when the item set (id + content + confidence + assertedAt) and the rollout-note set
   match the last SUCCESSFUL review. It re-runs whenever a new/changed/re-asserted fact or a
   new pending item appears, or a new deploy lands a fix that could flip a "still-true?" verdict.
   The failure-event log is deliberately excluded from the fingerprint (routine 429s/timeouts
   would otherwise force a re-review most days). The fingerprint is stored ONLY on success, so a
   failed/parse-failed run is retried the next day rather than skipped. New setting key
   `learning_review:lastFingerprint:<userId>`.

5. **Made the settings user-level (was account-level) — a real coherence fix.**
   `runDailyLearningReviewIfDue(userId)` reads `getPolicy(userId)` (the ACTIVE account's policy)
   and runs **once per user per day** over user-level learned context, but the three
   `learningReview*` fields were stored per-account — so which account's setting controlled the
   job depended on which account was loaded when the scheduler ticked. Added them to
   `USER_LEVEL_POLICY_FIELDS` (db-profiles.ts) so the config overlays every account consistently,
   and moved the card from THIS ACCOUNT → ALL YOUR ACCOUNTS.

## Questions answered

- **"Does the daily learning review take a different LLM call per account?"** No. It is entirely
  user-scoped: `isLearningReviewDue(userId)` / `buildLearningReviewContextPack(userId)`, keyed
  once per UTC day per user, over `learned_context` (per-userId) + the pending queue. One
  frontier call per user per day, regardless of connected-account count. (This change makes the
  *settings* user-level too, matching the job.)
- **"Which settings are user-specific vs account-specific?"** The app splits them explicitly
  (Settings page tags + `USER_LEVEL_POLICY_FIELDS`):
  - **ALL YOUR ACCOUNTS (user-level, overlay every account):** broker connections, API keys,
    event notifications (+ webhook), delivery channels, data sharing (pool consent + learned-fact
    sharing), market-scan shape (candidate limit + outlier reserve), boot behavior, and now the
    **daily learning review** (enabled/mode/model). Appearance/fonts are per-browser (localStorage).
  - **THIS ACCOUNT (per connected account / policy):** tax treatment, LLM models
    (Strategist/Reviewer), strategy prompt/scoring-weights, guardrails/risk rules, autonomy
    authority, advanced-action typed-confirmation, system state.

## Files

`src/lib/db-profiles.ts` (USER_LEVEL_POLICY_FIELDS), `src/lib/defaults.ts` (decide + explicit
model default), `src/lib/learning-review.ts` (remove hidden fallback + constant; decide default;
no-model skip), `app/console/settings/learning-review.tsx` (rename, drop blank option, decide
default, copy), `app/console/settings/page.tsx` (move card to ALL YOUR ACCOUNTS),
`test/learning-review.test.ts` (+3 tests), this note.

## Verification

- `npx tsc --noEmit` clean (after `npm install` picked up main's new `drizzle-orm` dep from the
  merged AG migration — unrelated to this change). `npx eslint` on touched files: 0 errors.
- `npm test` learning-review 15/15 (incl. new: decide+fable defaults on a fresh user; blank
  model → `no-model` skip; learningReview* set under account A1 visible under A2). Policy-scope
  suites (account-scope, per-user/per-account isolation, models-migration) 23/23.
- Driven live: card renders under ALL YOUR ACCOUNTS; model dropdown has no blank option
  (claude-fable-5 first); field labeled "Learning-review model"; Annotate/Decide options present.

## Migration note

Existing per-account `learningReview*` values (a day-old, off-by-default feature — near-zero real
usage) become user-level: on next read they're stripped from the account row and, absent a
user-level value, fall to the new defaults (off / decide / claude-fable-5). Anyone who enabled it
per-account re-confirms once at the user level. No data loss; `learned_context` is untouched.
