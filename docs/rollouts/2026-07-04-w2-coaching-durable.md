# 2026-07-04 - w2-coaching-durable

Branch `claude/w2-coaching-durable`, worktree `~/apps/trading-wt-w2-coaching`, cut from
`origin/claude/w1-learning-loops` (its lifecycle-update re-index-on-coach-note hook is the base
this lane builds on top of). One of the Wave-2 composite-review lanes (§A "How" specs). The exact
`docs/reviews/2026-07-04-composite-expert-review.md` file referenced by the task prompt is not yet
present on this branch's ancestry — `origin/claude/w1-learning-loops` (and this branch, cut from it)
forked from `origin/main` *before* that doc was merged to `main` at `c2ee3f03` (PR #363). The full
"How" text for all three assigned items was pulled directly via `git show c2ee3f03:docs/reviews/
2026-07-04-composite-expert-review.md` and used verbatim as the spec of record; the doc itself was
not copied into this branch (out of scope for this fileset, and it will arrive naturally once `main`
merges forward into this lane's ancestry).

Scope: three items from composite-review §A — (1) coaching becomes durable learning, (2) coach-note
vectors, (3) owner-approved risk-tier rows reach prompts. Fileset per the task: `db-socratic.ts`,
`socratic-memory.ts` (indexing helpers only), the learned-context ingestion pipeline (`ingestLearned`
+ its store writes), `db-learning.ts` (`listLearnedContextForDecision`), the coach-note API route.
Did not touch `strategy.ts`, `vector-db.ts` internals, or `post-mortem.ts` (other Wave-2 lanes'
filesets, or explicitly excluded).

## Summary

1. **Coaching becomes durable learning** (`src/lib/db-socratic.ts`, `src/lib/db.ts`,
   `src/lib/types.ts`). `appendSocraticDecisionCoachNote` is now `async` and, on every append:
   - **(a) Re-index** — unchanged from the w1 base (fires after the DB write, dynamic import to
     avoid the `db-socratic -> socratic-memory -> vector-db -> ./db` cycle).
   - **(b) `ingestLearned`** — the note is classified and routed through the existing
     `ingestLearned(userId, candidate, "coach")` pipeline with a **new origin `'coach'`**
     (`LearnedContextOrigin` widened from `"chat" | "autonomous" | "ingest"` to include `"coach"`).
     `'coach'` is NOT the `'chat'` origin, so it is never hard-capped — a fact-tier note lands a
     durable `learned_context` row (`subject: "coach:<decisionId>"`, so the row is greppably linked
     back to its originating decision); a risk/directive-tier note routes to the existing
     `learned_context_pending` human-confirmation queue exactly like an `'autonomous'`/`'ingest'`
     candidate would.
   - **(c) Archival, not silent truncation** — the live `socratic_decisions.coach_notes` column
     still keeps only the most recent `COACH_NOTES_LIVE_CAP` (20) notes for fast prompt/display
     access, but any note aged off that window is now **archived** into a new
     `socratic_coach_note_archive` table (append-only, `id, user_id, decision_id,
     connected_account_id, note, archived_at`) instead of being dropped by `slice(-20)` with no
     trace. A `socratic_decision_coach_notes_archived` audit receipt is emitted **only when
     archival actually occurred** this call (i.e. never on the first 20 notes).
   - **(d) "Coached" provenance** — the promotion outcome (written / pending / dropped) is stamped
     as a new `kind: "coaching"` `SocraticEvidenceItem` on the decision case (that union member
     already existed in `types.ts`, just unused until now). Because `buildSocraticMemoryDocument`
     (unchanged) already renders `evidence` into the vector-memory doc's `evidence:` line, a coached
     case's retrieved memory text now carries e.g. `"Coach note promoted to durable lesson: <note
     text>"` — the "coached" + promoted-to-durable-lesson provenance the item calls for.
   - Best-effort: a classifier/LLM failure during `ingestLearned` never blocks the append itself —
     it degrades to a `"pending retry"` evidence note; the synchronous DB write (append + archive +
     receipt) always happens regardless.

2. **Coach-note vectors** (`src/lib/socratic-memory.ts`). New `buildCoachNoteMemoryDocument` +
   `indexCoachNoteMemory`, modeled directly on the existing `buildSocraticMemoryDocument`/
   `indexSocraticDecisionMemory` pair. Each note becomes its own vector: `text` is the raw note (so
   it embeds as the owner's own words), `metadata` is exactly `{symbol, source: "socratic-coach-
   note", timestamp, accession: "<decisionId>:<noteIndex>", doc_type: "coach-note", decision_id,
   thesis_tag?, regime?, connected_account_id?}` per the design note's "keep the helper's shape
   simple and documented." `dedupKeyPrefix: "coach-note"` is a disjoint namespace from the parent
   decision doc's `"socratic-decision"` prefix, and `noteIndex` (the note's position in the
   decision's all-time coach-note history) makes the accession unique per note — so this is always
   an **additive** new vector, never an overwrite of a sibling note or the parent doc. Wired into
   `appendSocraticDecisionCoachNote` right after the decision-doc re-index.

3. **Owner-approved risk-tier rows reach prompts** (`src/lib/db-learning.ts`,
   `src/lib/learned-context/store.ts`). New `listApprovedRiskContextForDecision(userId, symbols)` in
   `db-learning.ts` — a sibling to `listLearnedContextForDecision`, but reads `risk_tier = 'risk'`
   (not `'fact'`) rows, still filtered to `superseded_by IS NULL`, non-expired, and symbol-scoped
   (plus symbol-less general rows). Deliberately scoped to `user_id = ?` only (never the `'shared'`
   scope some fact rows use) — an owner's approved risk guidance is a personal act, never pooled
   across users. `retrieveLearnedContext` in `learned-context/store.ts` now calls this after
   building its ordinary fact-bullet list and, when any approved risk rows exist, appends a labeled
   `"OWNER-APPROVED GUIDANCE (advisory):"` block with each row rendered as `"- [SYM] subject: value
   (approved YYYY-MM-DD)"`. The approval date is `assertedAt` on the promoted row — `
   applyApprovedPending` (unchanged) stamps `assertedAt: new Date().toISOString()` at the moment of
   promotion, since the row didn't exist in `learned_context` before the owner approved it, so
   `assertedAt` on a risk-tier row IS its approval timestamp. The never-feeds-deterministic-sizing
   invariant is preserved unchanged: this is still a `string[]` of advisory bullet lines from the
   same DATA-only retrieval function — nothing here is a parsed/typed number that could reach
   sizing math.

## Why

- **Item 1**: a coach note used to be inert prose capped at `slice(-20)` — never durably learned
  from, and the 21st note silently deleted the oldest with zero trace. That is exactly the "chat
  history that doesn't change behavior" failure the product philosophy rejects, and it is also data
  loss with no receipt, which the philosophy separately treats as unacceptable ("receipts/advisory
  everywhere"). Routing through the same `ingestLearned` pipeline every other producer
  (chat/autonomous/post-mortem) already uses reuses a well-tested classifier/routing path instead of
  inventing a new one, and gives coaching the same durability/inbox/audit guarantees.
- **Item 2**: a coaching THEME repeated across many notes on many decisions ("consistently timid on
  high-conviction entries") has no retrievable representation if a note only ever lives embedded
  inside one decision's full-case text. A standalone `doc_type: 'coach-note'` vector lets a future
  episodic-retrieval query pull coaching guidance directly, cross-decision, instead of only ever
  finding it buried in whichever single case happened to receive that note.
- **Item 3**: the learned-context approval inbox was a write-only ritual for risk-tier rows — a
  human would explicitly approve "cap NVDA at 25% of book," and that approval would sit in
  `learned_context` forever unread by any prompt, because `listLearnedContextForDecision` hard-
  filters `risk_tier = 'fact'`. Closing this loop (as clearly labeled advisory guidance, never a
  number) makes the approval action actually mean something.

## Files

- `src/lib/types.ts` — `LearnedContextOrigin` widened to include `"coach"`.
- `src/lib/db.ts` — new `socratic_coach_note_archive` table (`migrate()`); `CREATE TABLE IF NOT
  EXISTS learned_context` / `learned_context_pending` CHECK constraints widened to accept `'coach'`
  for fresh DBs; a new guarded, idempotent rebuild (inspects `sqlite_master.sql` for `'coach'`
  before rebuilding) so an EXISTING on-disk database (pre-dating this change) also accepts `'coach'`
  inserts without violating its old CHECK constraint — verified against both a synthetic
  pre-migration DB (legacy rows preserved through the rebuild) and a fresh DB.
- `src/lib/db-socratic.ts` — `appendSocraticDecisionCoachNote` rewritten (now `async`): `ingestLearned`
  call, archival (`archiveCoachNotes`, `socratic_coach_note_archive` CRUD), receipt audit event,
  `coaching`-kind evidence stamp, coach-note vector indexing. New exported `listArchivedCoachNotes`
  and `ArchivedCoachNote` type.
- `src/lib/socratic-memory.ts` — new `buildCoachNoteMemoryDocument`/`indexCoachNoteMemory`.
- `src/lib/db-learning.ts` — new `listApprovedRiskContextForDecision`.
- `src/lib/learned-context/store.ts` — `retrieveLearnedContext` appends the labeled
  "OWNER-APPROVED GUIDANCE (advisory)" block.
- `app/api/socratic/decisions/[id]/coach/route.ts` — `await`s the now-async
  `appendSocraticDecisionCoachNote`.
- `src/lib/account-deletion.ts` — added `socratic_coach_note_archive` to
  `DELETE_TABLES_BY_USER_ID` (caught by the pre-existing `account-deletion-coverage.test.ts`
  regression guard, which fails closed on any new user-scoped table missing from the deletion list).
- `app/console/approvals/learned-context.tsx` — `ORIGIN_LABEL` map gained a `coach` entry (the
  widened `LearnedContextOrigin` union made this a compile error); updated its doc comment, which
  previously asserted approved risk rows never reach retrieval — item 3 makes that claim false, so
  the comment was corrected in the same edit rather than left stale.
- `test/socratic-db.test.ts` — new `describe("Coaching becomes durable learning …")` block: fact-tier
  note -> durable `learned_context` row + `coaching` evidence; risk-tier note -> pending inbox +
  evidence; archival at the 21st note with exactly one receipt and the archived note's exact text
  preserved (never deleted); coach-note vector shape (`doc_type`, `decision_id`, `thesis_tag`,
  `regime` metadata, dedupKeyPrefix `"coach-note"`). Existing test's `dedupKeyPrefix` filter
  tightened to `"socratic-decision"` (a coach note's text now also appears in the new standalone
  coach-note vector, so a text-only filter was no longer selective enough) plus a new assertion that
  the coach-note vector call also fired.
- `test/learned-context-pending.test.ts` — new `describe("owner-approved risk-tier rows reach the
  retrieval payload …")` block: `listApprovedRiskContextForDecision` returns the approved row but
  the fact-only `listLearnedContextForDecision` does not; symbol scoping; an unapproved (still-
  pending) risk candidate is excluded; `retrieveLearnedContext` renders the labeled block with the
  approval date.
- `STATUS.md`, `docs/EFFORT-LOG.md`, `/Users/jay/apps/TRADING-EFFORT-LOG.md` — lane status
  entries added/updated (the `coaching-durable` sub-lane row under the Wave-2 umbrella bullet moved
  from planned description to implemented-with-status).

## Verification

- `npx tsc --noEmit` — clean (0 errors).
- `npm run lint` — 0 errors; pre-existing grandfathered warning backlog only (no new warnings in any
  touched file).
- `npm test` — **245 files / 2383 tests passed** (base was 2377; net +6 from the two new describe
  blocks above; `test/account-deletion-coverage.test.ts` initially caught the missing
  `socratic_coach_note_archive` registration, fixed in `account-deletion.ts`, then green).
- `npm run build` — succeeded.

A genuine Vitest/Vite module-runner quirk was hit and worked around during test-writing: two
**concurrent** dynamic `import()` calls of the same `vi.mock`-intercepted specifier
(`./vector-db`) inside a single `Promise.all` race, and only one of the two calls resolves through
the mock — the other falls through to the real (unmocked) module. Reproduced in isolation with a
minimal repro (two concurrent calls to the identical function), confirmed sequential/awaited calls
never race. Fixed by sequencing `indexSocraticDecisionMemory` then `indexCoachNoteMemory` inside the
existing fire-and-forget `.then()` instead of `Promise.all`-ing them — functionally equivalent (both
are independent, best-effort, order-agnostic re-index calls) and avoids the test-infra race entirely
(production has no mocks, so the race was never reachable there — this is a test-writing note, not a
product bug that was ever live).

## Follow-ups

- **`docs/reviews/2026-07-04-composite-expert-review.md` is not yet in this branch's history** — it
  will arrive naturally once `main` (which has it, PR #363) merges forward into the Wave-1/Wave-2
  lane ancestry. No action needed here; noted so a future session isn't confused when `git log` on
  this branch doesn't show the file.
- **Episodic-retrieval lane dependency**: the composite review's item 1 text explicitly says the
  episodic-retrieval lane will consume the `'coach-note'` doc_type this item produces (a second
  retrieval pass over `['socratic-decision','coach-note','lesson-rollup']`). Per `TRADING-EFFORT-
  LOG.md`, `claude/w2-episodic-retrieval` already implemented that consuming side (retrieval pass
  over `['socratic-decision','coach-note','lesson']`) on 2026-07-04 — the two lanes are compatible on
  the `doc_type: 'coach-note'` contract without any coordination needed beyond this shared naming,
  since both were built from the same composite-review text.
- **`socratic_coach_note_archive` has no read-side UI yet** — `listArchivedCoachNotes` is exported
  and tested but not yet wired into any console surface; a "coaching history" or "archived notes"
  view is a natural follow-up for whichever lane owns the Socratic decision-detail console UI.
- **`reflection-decompose` lane** (structured regime/thesis-conditioned lesson rows, replacing the
  opaque per-account reflection blob) is the remaining Wave-2 sub-lane under the same umbrella;
  unrelated to this item's fileset and not started here.
