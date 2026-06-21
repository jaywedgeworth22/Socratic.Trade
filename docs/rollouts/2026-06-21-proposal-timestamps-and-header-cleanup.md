# 2026-06-21 — Proposal timestamps + staleness, and command-bar status cleanup

## Summary

Three UI changes to the dashboard command bar and the Decision view, driven by
operator feedback (with an annotated screenshot):

1. **Pending proposals now show when they were proposed, plus a staleness
   warning.** Each card in "Pending approval" displays `Proposed <date, time> ·
   <relative age>` (e.g. `Proposed Jun 21, 2:34 PM · 3h ago`). Because proposals
   sit in the queue until a human approves/rejects them, an old one used to look
   just as "current" as a fresh one. The age now escalates visually:
   - `< 1h` — fresh, faint timestamp only.
   - `≥ 1h` — **Aging** (amber) chip + a caution line: "Prices and conditions may
     have changed since this was proposed — re-run the strategy before approving."
   - `≥ 24h` — **Stale** (red) chip + the same caution line.
2. **Removed the redundant "Test Mode" status line** (blue dot) from the command
   bar's brand block. The persistent tri-state execution safety banner at the very
   top of the page already states Test / Paper / Brokerage, so the third status
   line was duplicative. The brand block now shows two lines: autonomy state and
   market session.
3. **Fixed the command bar looking "too thin" / clipped.** The header was pinned
   to a fixed `h-14` (56px) with `py-0` at `xl`, which clipped the stacked status
   lines. It is now a flexible `min-h-16` with normal padding, so it never clips
   and reads as a balanced bar with the two remaining status lines.

## Why

- The operator could not tell a freshly-generated proposal from one the agent
  produced hours/days/weeks ago, since the queue persists until answered. Showing
  the proposal time + an explicit staleness state prevents acting on a stale idea.
- The brand block stacked three status dots (autonomy / market / mode) under a
  fixed-height bar; "Test Mode" duplicated the top safety banner and the third
  line overflowed the fixed height, which is what looked wrong.

## Flow button (question raised, no change made)

The operator asked what the **Flow** button is for. It opens a full-screen
"Strategy Flow — Pipeline & node visualizer" modal (`app/ui/strategy-flow.tsx`,
React Flow / `@xyflow/react`). It is a **static, illustrative** diagram of the
data → vector-DB → agents → execution pipeline with **hardcoded** placeholder
nodes (SEC Filings, Yahoo News, FRED Macro → Pinecone → Evaluator/Trader agents).
It is read-only (pan/zoom only), is not data-driven, and does not drive any
behavior. Left in place pending a product decision on its final purpose.

## Files

- `app/ui/dashboard/utils.tsx` — added `proposalAge()` + `relativeAge()` helpers
  and `PROPOSAL_STALE_AFTER_MS` / `PROPOSAL_VERY_STALE_AFTER_MS` thresholds.
- `app/ui/dashboard/views.tsx` — render the timestamp + staleness block in the
  pending-approval cards; import `Clock` icon and `proposalAge`.
- `app/dashboard-client.tsx` — removed the "Test Mode" status line, removed the
  now-dead `executionTone()` helper, and changed the header sizing classes
  (`min-h-14 … xl:h-14 … xl:py-0` → `min-h-16 … xl:min-h-16`).

## Verification

- `npx tsc --noEmit` — clean (after a fresh `npm install` in this container).
- `npm test` — 40 files, 307 tests passing.
- `npm run build` — green.

## Follow-ups

- Staleness thresholds (1h / 24h) are constants in `utils.tsx`. If operators want
  them configurable (per-policy expiry, or auto-cancel of stale proposals), that
  would be a backend/policy change (schema + scheduler) rather than UI-only.
- Flow button: awaiting a product decision on whether to make it data-driven,
  repurpose it, or remove it.
