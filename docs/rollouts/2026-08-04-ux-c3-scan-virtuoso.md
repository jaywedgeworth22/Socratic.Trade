# Rollout: UX PR-C3 — Scan table virtualization (TableVirtuoso)

**Date:** 2026-08-04  
**Branch:** `grok/ux-c3-scan-virtuoso`  
**Agent:** GROK  
**Program:** `docs/design/ux-improvement-program.md` §PR-C3

## Context & Objective

Wave C speed work: Market Scan desktop table rendered every candidate cell on each scan update (~100 rows × ~13 columns). `react-virtuoso` was already a dependency and historically used on the pre-console `MarketScanView`; the console scan route never got the same treatment. Virtualize the desktop body so only visible rows mount while preserving sort, column picker, sticky symbol, watch toggle, and SymbolButton drilldown.

## Changes Made

- Desktop (`lg+`) scan table now uses `TableVirtuoso` inside a fixed-height scroller (`h-[min(600px,65vh)]`).
- Module-stable custom components: Scroller (`overflow: auto` for both axes), `con-table` Table, TableHead, TableRow (`group` for sticky-cell hover).
- SCN-2 lessons: `overscan={600}`, `initialItemCount={Math.min(rows.length, 20)}`, `computeItemKey` by symbol.
- Sticky symbol column + sort header buttons + column visibility chooser + mobile card list unchanged in behavior.
- No new dependencies.

### Touched files

- `app/console/scan/scan-table.tsx`
- `docs/rollouts/2026-08-04-ux-c3-scan-virtuoso.md` (this note)
- `docs/EFFORT-LOG.md`
- `STATUS.md`

## Decisions & Trade-offs

- **Desktop-only virtualization.** Mobile already uses a compact card list (`lg:hidden`); acceptance “mid phone” is covered by that path not mounting the wide table. Phone still renders all cards (typically ≤100); follow-up if card list becomes a hotspot.
- **Fixed-height scroller** required for virtuoso windowing (page no longer grows with all rows on desktop). Matches the historical dashboard scan height.
- **Scroller forces `overflow: auto`** so horizontal column overflow works; sticky left symbol pins against that scroller (audit finding: default virtuoso scroller is overflowY-only).

## Verification State

Commands (worktree, Node 24 PATH):

```bash
npm run lint
npx tsc --noEmit
npm test
# land.sh also runs build
```

Record results in the PR / land output.

## Next Steps & Blockers

- None for C3. Remaining Wave C: PR-C1 snapshot TTL cache, PR-C2 FIFO P&L once, PR-C4 React.memo leaves — still UNASSIGNED unless claimed.
- Optional follow-up: virtualize mobile card list if profiling shows cost on low-end phones.

## Zero-Code Findings

- Confirmed no live `TableVirtuoso` import remained in tree after console refactor; only `package.json` dep + docs/historical references. Re-introduced usage on the current console scan surface.
