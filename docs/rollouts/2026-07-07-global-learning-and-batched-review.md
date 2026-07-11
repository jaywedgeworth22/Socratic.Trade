# 2026-07-07 — Global learning reads + batched AI review of proposals

## Summary

Two related changes to the Socratic learning system, both requested by the owner:

1. **Learning is now GLOBAL across a user's accounts** (with per-account provenance
   preserved). Decision cases (which carry the extracted `lessons`) and framework /
   "learning" proposals are read user-wide instead of filtered to the active account.
   Each row still stores `connected_account_id` / `accountNumber`, so provenance is
   intact and reverting to per-account is a one-line change.
2. **A single-LLM-call batched reviewer** for pending framework proposals. One request
   adjudicates every pending proposal across all accounts and attaches an **advisory**
   recommendation (verdict + rationale + optional rewrite) to each — the owner still
   makes the final accept/reject/rewrite call.

## Why / decisions

- The owner asked to "bring [learning] out of the individual account" and confirmed
  keeping the originating account "just in case." So: change the **read path** to global,
  keep **writing** `connected_account_id` as provenance. No migration, no data loss.
- This also fixes a pre-existing **inconsistency**: the dashboard scoped proposals to the
  active account while the decision-detail page already fetched them user-wide. Both are
  global now.
- The batched reviewer is **advisory, not auto-apply.** Auto-finalizing the owner's
  accept/reject/rewrite verbs on the strategy framework would be exactly the
  "obedience-hardening" the repo philosophy warns against — so the AI attaches an opinion,
  the owner decides. (Efficiency note that drove the batching: post-mortem lesson
  *generation* stays one-call-per-decision because its per-item context/schema is
  load-bearing; the *proposal review* is a small, deduped queue that batches cleanly.)
- Reviewer model reuses the existing "AI Review" inheritance: account policy's
  `redTeamLlmModel` → `llmModel` (`reviewerPolicy` in `framework-review.ts`).

## Files

- `src/lib/dashboard.ts` — read `listSocraticDecisionCases` / `listSocraticFrameworkProposals`
  user-wide (dropped the active-account filter for the learning panels only; positions/
  fills/performance stay account-scoped).
- `src/lib/db.ts` — migration: nullable `ai_review` column on `socratic_framework_proposals`.
- `src/lib/types.ts` — `SocraticFrameworkAiReview` + `aiReview?` on `SocraticFrameworkProposal`.
- `src/lib/db-socratic.ts` — `ai_review` in the row type + mapping; new
  `setSocraticFrameworkProposalAiReview` (does not touch status/verb).
- `src/lib/framework-review.ts` (new) — `reviewPendingFrameworkProposals(userId)`: one LLM
  call, array-output keyed by proposal id, demux back to ids, budget-gated + fail-open,
  usage-recorded, audited (`socratic_framework_ai_review`).
- `src/lib/llm-request.ts` — `LLM_OUTPUT_TOKEN_CAPS.frameworkReview`.
- `app/api/socratic/framework/review/route.ts` (new) — `POST` runs the reviewer, returns
  the summary + refreshed proposal list.
- `app/console/page.tsx` — `FrameworkProposalList`: "AI review pending" button (one call),
  per-proposal recommendation block, "Use suggested rewrite", "across all accounts" header.
- `test/framework-review.test.ts` (new) — global reads + provenance; `ai_review` round-trip
  (status/verb untouched); batched reviewer (one call, red-team model, per-proposal review,
  ignores hallucinated ids, advisory-only, fail-open on no key).

## Verification

```
npx tsc --noEmit   # clean
npm run lint       # 0 errors
npm run build      # exit 0
npx vitest run test/framework-review.test.ts test/socratic-db.test.ts \
  test/socratic-runtime.test.ts test/learning-loop.test.ts test/learning-loop-backlog.test.ts
# 31 tests passed
```

## Review fixes (PR #1417, Codex)

- **Kept decision cases account-scoped.** Making the shared `socratic.decisions` feed global
  would have leaked another account's latest decision into the ACTIVE account's Live thesis /
  Autonomous actions / coach form (`primaryDecision = decisions[0]`). Reverted: decisions stay
  account-scoped; only framework proposals (a separate panel) are global. Lessons therefore stay
  on the account's own decisions — a dedicated global lessons view is the follow-up if wanted.
- **Reviewer resolves through the RED role.** `resolveLlmEndpoint(policy, userId, url, "red")`
  natively inherits `redTeamLlmModel → primary` AND picks up a cross-family reviewer credential
  when `redTeamLlmModel` is unset — replaced the hand-rolled model-copy which used the green role.
- **Backlog advance.** The reviewer now selects pending proposals that are NOT yet AI-reviewed
  (`!aiReview`), so repeated runs move through the backlog instead of re-reviewing the newest rows
  (the review is advisory and leaves status = pending). New `all_reviewed` skip reason.
- **Fail-open on transport errors.** The LLM call is wrapped in try/catch → returns
  `skippedReason: "llm_error"` instead of 500-ing the route on timeout/DNS/abort/invalid-JSON.
- **Structured output.** Passes `openAiJsonObject: true` so a model can't wrap the batch in prose
  and make `parseReviewResponse` drop everything.
- **UI button not gated on the truncated count.** The dashboard proposal list is capped at 25
  (mixed status); the review route works the full server-side backlog, so the button is live
  whenever not already reviewing (was disabled when the shown window happened to be all resolved).

## Follow-ups

- Surface a **friendly account label** (name, not raw id) as the provenance tag on
  each cross-account lesson/proposal in the UI.
- Optional: an autonomous cadence for the batched reviewer (currently owner-triggered via
  the button / `POST /api/socratic/framework/review`).
- Optional: let the owner one-click "apply AI rewrite" (accept with the AI's rewritten text)
  — still an owner action, just fewer keystrokes.
