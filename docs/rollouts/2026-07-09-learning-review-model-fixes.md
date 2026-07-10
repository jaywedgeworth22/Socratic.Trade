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

---

## Follow-up (same day): review-round fixes + adopted trigger feature

Seven verdict-REAL findings from the PR #1278 review round, fixed in one commit (each with a
regression test that fails pre-fix), plus MONET's uncommitted trigger feature found in the
worktree, adopted and finished in its own commit.

### Adopted (MONET WIP, finished)

- **Lesson-count/max-wait trigger**: the daily review now fires only when >=
  `learningReviewMinNewLessons` (default 5) NEW lessons accumulated since the last successful
  review, OR the oldest un-reviewed lesson waited `learningReviewMaxWaitDays` (default 7) — still
  capped at one run per UTC day. `lastReviewedAt` marker stored only on fully-successful runs.
  Finishing touches: corrupt-knob NaN hardening, `/api/policy` bounds validation, trigger tests.

### Fixed (review findings)

1. **No-account overlay** (`db-profiles.ts` getPolicy else branch): user-level fields
   (learningReview*, notificationSettings, marketScan*) now overlay the base policy when the user
   has no active connected account — an enabled review no longer silently reads as disabled on the
   scheduler path. (peekPolicy left as-is: it never applied the user overlay in any branch and its
   read-only contract conflicts with the lazy seed.)
2. **Profile ops preserve user fields** (`writePolicyBlobPreservingUserFields`): profile
   create/update/activate used to overwrite `user_settings.policy` with the full profile blob,
   resetting user-level fields to profile defaults. Now the stored user-level values are overlaid
   before the write (also repairs the pre-existing notification/market-scan clobber).
3. **Blank model save 400s** (`app/api/policy/route.ts`): the delete-on-blank special case for
   `learningReviewModel` is removed — with the explicit claude-fable-5 default it had become a
   silent revert-to-default. A blank now falls through to validatePolicy's non-empty rule
   (mirrors the Red-model precedent); the runner's `no-model` skip stays as a corrupt-data backstop.
4. **Fingerprint keys on config** (`reviewFingerprint(pack, mode, model)`): flipping
   annotate->decide or switching the reviewer model now forces a fresh review instead of hitting
   the "unchanged" skip.
5. **Legacy seed** (`seedLegacyLearningReviewFields`): one-time lazy copy of account-scoped
   (#1116-era) learningReview* values into `user_settings.policy` on first read when absent —
   supersedes this note's earlier "re-confirms once" migration note; the cutover is lossless now.
6. **Coverage gating**: the unchanged-set fingerprint (and `lastReviewedAt`) is stored only when
   EVERY shown item received a valid verdict — a partial response is re-attempted the next day
   (daily marker still advances, so at most one extra LLM call/day).
7. **Apply-failure gating**: `applyLearningReviewVerdicts` now returns
   `{ applied, failures }`; any thrown per-item application (audited as
   `learning_review_apply_error`) blocks the fingerprint store so the set is retried.

### Files

`src/lib/db-profiles.ts`, `src/lib/learning-review.ts`, `src/lib/defaults.ts`, `src/lib/types.ts`,
`app/api/policy/route.ts`, `test/learning-review.test.ts`,
`test/learning-review-policy-route.test.ts` (new), this note.

### Verification

- `npx tsc --noEmit` clean.
- Focused suites: `learning-review` 26/26, `learning-review-policy-route` 3/3,
  `per-account-policy-isolation` + `account-scoped-models-migration` green (43 tests total).
- Pre-fix falsification run: with the src fixes stashed, 8 of the new tests fail (all seven
  finding repros + the return-shape change) — confirming each test pins its bug.

### Follow-ups

- Settings UI knobs for the two trigger fields (API + defaults only today).
- peekPolicy still omits the user-level overlay everywhere (pre-existing, diagnostics-only).
