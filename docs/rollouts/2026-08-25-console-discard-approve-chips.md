# 2026-08-25 — Console honesty: Discard, approve typed-confirm, Coach chips

## Context & Objective

Three live Socratic.Trade console bugs from the 2026-08-20 desktop review were still on `main`.  This pass root-causes and fixes them in one PR so Discard, Approve, and Home Coach chips match the server and stop lying.

## Changes Made

Designer hypothesis for Discard was verified and kept: Universe fields live in page-local `universeDraft`, while PolicySaveBar Discard only called `draft.clear()`.  After Discard, `extraPatch` was still rebuilt from the dirty universe draft, so Universe edits stayed dirty and could persist on the next commit.  One `discardAll` now clears the field draft and resets `universeDraft` to `{}` (inputs fall back to live policy values).

Approve cards used `realityForMode(pending.executionMode)` only.  A NULL stamp rendered NO ACCOUNT, skipped typed confirm, and the 409 catch only toasted — so the phrase could never be typed.  Client now mirrors the server: `row.executionMode ?? currentMode`.  On 409, the existing typed sheet opens with the server's `expectedText`.  Bulk approve uses the same fallback and re-opens the batch sheet on 409 instead of toasting.  Home Proposal Details no longer titles a toast Approved unless `placed` / `filled` / `paper`.

Home Coach chips had no `onClick` / `href`.  They are now Title Case buttons that prefill and focus the coach note.

Touched files:

- `app/console/guardrails/universe-draft.ts` (new)
- `app/console/guardrails/page.tsx`
- `app/console/components/policy-form.tsx`
- `app/console/lib/approval-honesty.ts` (new)
- `app/console/lib/coach-chips.ts` (new)
- `app/console/components/approval-card.tsx`
- `app/console/approvals/triage.ts`
- `app/console/approvals/page.tsx`
- `app/console/page.tsx`
- `test/console-universe-discard.test.ts` (new)
- `test/console-approval-honesty.test.ts` (new)
- `test/console-coach-chips.test.ts` (new)
- `test/approvals-triage-model.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-25-console-discard-approve-chips.md`

## Decisions & Trade-offs

- Kept universe state on the Guardrails page.  Moving those fields into `usePolicyDraft` would be a larger rewrite and was not required once Discard resets both drafts.
- Did not change server `assertLiveApprovalConfirmation` or the bulk-approve route.  The server contract stays authoritative; the client now asks for the same phrase the server already returns.
- Did not rewrite 409 / busy / blocked copy.  Existing card phrases are reused.
- Coach chips hide when there is no decision case (the form itself is null).  That avoids fake buttons with nowhere to attach a note.
- Title Cased the bulk Approve/Reject labels in the same file as the honesty fix (owner button rule).  No Designer visual redesign.
- Stayed off #3090 (RAG) and #3077 (dependabot).  No Datadog / RUM / Pinecone / RAG edits.

## Verification State

Commands actually run on this seat:

```bash
npm run lint
npx tsc --noEmit
npx vitest run test/console-universe-discard.test.ts test/console-approval-honesty.test.ts test/console-coach-chips.test.ts test/approvals-triage-model.test.ts
npm run build
```

- `npm run lint`: exit 0 (0 errors; grandfathered warnings only).
- `npx tsc --noEmit`: exit 0.
- Targeted vitest: 4 files / 19 tests passed.
- `npm run build`: exit 0 (Next.js 16.3.1 webpack).

A full `npm test` in this cloud VM was still running after ~17 minutes and had already failed in untouched files (`vector-db-*`, `corpus-reembed*`, `rag-doc-type-coverage`, `history`, `persistence-notification`, `strategy-held-position-retrieval-scope`, `alpha-vantage-key-pool`, `server-metrics`).  Those are RAG / network / env paths this seat was told not to touch.  They are not in this PR's diff.  Authoritative CI is `verify-hosted` on PR #3093.

This seat does not deploy, compile iOS, or merge.  Auto-merge on #3093 was disabled so a green check cannot land it.

## Next Steps & Blockers

- Human review of the PR.  Do not merge from this seat.
- After merge, weekday RTH latch may hold the image until the cash close unless `HOTFIX=1`.
- Remaining desktop-review P2s (tab titles, inbox contrast, tooltip aria, scope-menu keyboard) are out of scope.

## Zero-Code Findings

Designer Discard hypothesis is correct.  Approve dead-end is the same root as the 2026-08-20 audit: client used the row stamp alone; server uses `row.executionMode ?? currentMode`.  Home "Approved" on `busy` is `handleApprove` titling success from `res.status` after the busy-retry loop returns `busy`.
