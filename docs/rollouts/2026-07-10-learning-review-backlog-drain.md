# 2026-07-10 — Learning-review >80-item backlog drain (PR #1278 deferred finding #2)

## Summary

Fixed the daily learning-review job silently marking a large backlog of learned
lessons "reviewed" without ever auditing them. `buildLearningReviewContextPack`
(`src/lib/learning-review.ts`) sliced the reviewable items to the first
`MAX_REVIEW_ITEMS` (80) in an arbitrary pending-first order, and a "complete"
review then advanced the `learning_review:lastReviewedAt` marker to run-start
`now`. Because `evaluateLearningReviewTrigger` counts un-reviewed lessons as
those with `assertedAt`/`createdAt` **>** `lastReviewedAt`, every item past the
80-item budget (timestamp `<= now`) stopped counting toward BOTH the trigger's
`newCount` AND its `max-age` — so on a >80-item store those overflow lessons
could **never** be audited, defeating the feature's whole purpose (catching
corrupted learned lessons) for exactly the users who accumulate the most of them.

The fix:
1. **Sweep the OLDEST un-reviewed items first** within the budget (the ones
   closest to aging out unaudited), then fill any leftover budget with
   already-reviewed items (a re-audit against fresh system-history), newest-first.
2. Add **`truncated`** and **`reviewedThroughMs`** to `LearningReviewContextPack`.
3. Advance `lastReviewedAt` to `pack.reviewedThroughMs` instead of unconditional
   `now`: that is `now` on a non-truncated run, else **just below the oldest
   DROPPED un-reviewed item** — so the dropped (strictly-newer) items keep
   counting toward the trigger and are swept on later daily runs. The fingerprint
   is still stored on every fully-successful run (see "Why deferred" below).
4. Record `truncated` in the `learning_review_summary` audit for observability.

Net effect: a >80-item backlog now drains completely across successive daily
runs (80 oldest-un-reviewed per run), with **no item ever silently marked
reviewed**, and no extra LLM spend once drained.

## Why (decisions)

- **Why not just gate the marker on `!truncated`?** That was the trap that made
  this a non-one-liner (called out in the deferred-finding note). The fingerprint
  of the exact reviewed set is stored in the same `if (complete && failures === 0)`
  block. In **annotate** mode nothing is mutated, so the backlog only drains via
  the marker advancing. If a truncated run refused to advance the marker at all,
  annotate mode would re-show the same oldest-80 slice **and** never store the
  fingerprint, re-running the frontier-class LLM on an identical set every single
  day forever. The fix keeps advancing the marker (conservatively) and keeps
  storing the fingerprint on truncated runs, so the shown slice changes each day
  (drains) and identical sets still short-circuit.

- **Why `oldestDropped - 1ms`, not the "newest shown" timestamp?** Tie-safety.
  The trigger's test is strict `>`. If several items share the boundary
  millisecond and we set the marker to the newest **shown** timestamp, a dropped
  tie-mate at the same ms would be `<= marker` and get orphaned. Setting the
  marker to `oldestDropped - 1ms` guarantees every dropped item stays `> marker`
  (never orphaned); at worst a shown item tied with the first dropped item is
  harmlessly re-shown next run. It is also monotonic (`oldestDropped > lastReviewedAt`).

- **No regression to the 8da047aa max-age fix.** `reviewedThroughMs` only ever
  moves the marker to `<= now` — strictly **more** conservative than the previous
  unconditional `String(now)`. Non-truncated runs are byte-for-byte the old
  behavior (`reviewedThroughMs === now`), and the empty-pack "no-items" skip is
  untouched (marker still does not advance there). So the out-of-window learned
  rows that 8da047aa made reachable behave exactly as before; the shipped
  regression test for that path ("max-age fires for a LEARNED row older than the
  7-day window") still passes.

- **Kept the candidate SET identical** (all pending + learned within the 7-day
  pack window). Only the ORDERING and the marker math changed, so small stores
  (<= 80 items) see zero behavioral change beyond item order (which does not
  affect verdicts, the internally-sorted fingerprint, or coverage).

## Files

- `src/lib/learning-review.ts`
  - `LearningReviewContextPack`: added `truncated: boolean` and
    `reviewedThroughMs: number`.
  - `buildLearningReviewContextPack`: partition candidates into un-reviewed
    (`Date.parse(at) > lastReviewedAt`) sorted oldest-first and reviewed sorted
    newest-first; `items = [...unreviewed, ...reviewed].slice(0, MAX_REVIEW_ITEMS)`;
    compute `truncated` / `reviewedThroughMs`.
  - `runDailyLearningReview`: `learning_review_summary` audit now includes
    `truncated`; the `complete && failures === 0` block persists
    `lastReviewedAt = String(pack.reviewedThroughMs)` (was `String(now)`).
- `test/learning-review.test.ts`
  - New describe "backlog drain when reviewable items exceed MAX_REVIEW_ITEMS
    (deferred PR #1278 finding #2)": pack-truncation flag/marker assertions, a
    not-truncated control, and an `it.each(["annotate","decide"])` 200-item
    drain that asserts every seeded item is shown across exactly 3 daily runs
    with none silently marked reviewed and the store never mutated away.
- `docs/EFFORT-LOG.md` + `/Users/jay/apps/TRADING-EFFORT-LOG.md` — In Progress row.
- `STATUS.md` — snapshot.

## Verification

All run with node@24 on PATH (`/opt/homebrew/opt/node@24/bin`) — the Mac default
`node` is v26 and mismatches the `better-sqlite3` ABI (see the mac-node26 trap).

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx tsc --noEmit                              # clean (0 learning-review errors; only the pre-existing alternative-data.test.ts mismatch)
npx vitest run test/learning-review.test.ts   # 34 passed (30 prior + 4 new)
npx vitest run                                # 314 files / 3338 tests passed
npx eslint src/lib/learning-review.ts test/learning-review.test.ts  # 0 errors
npm run build                                 # (see status; full Next.js build)
```

## Follow-ups / notes

- Base: built on MERGED `main` (`6f1aaf87`, PR #1278) — the target code landed
  earlier the same day, so this is a clean follow-up PR to main via
  `scripts/land.sh` (not stacked on the #1278 branch).
- This closes the LAST open #1278 deferred item. #1278 deferred finding #3
  (legacy-seed default-blob edge, `db-profiles.ts`) is a separate follow-up
  already IN PROGRESS by a peer MONET session
  (`monet/learning-review-legacy-seed-99138a`).
- Pre-existing, out of scope, NOT introduced here: when an out-of-window
  un-reviewed learned row (asserted > 7 days ago, excluded from the pack) coexists
  with within-window items, a completed review still advances the marker past it
  (marking it reviewed without individually showing it). That is the accepted
  8da047aa behavior — the max-age trigger's job is to force a sweep, and the
  out-of-window row itself is too old for the review window. This fix neither
  worsens nor addresses that; it only stops **in-pack** overflow items from being
  orphaned.
