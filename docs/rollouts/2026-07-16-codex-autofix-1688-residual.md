# 2026-07-16 — Codex residual fixes: exit-strategy design doc corrections

## Summary
Addressed 2 of 4 Codex review findings submitted after PR #1688 was merged:
- P2: Corrected Robinhood option-positions claim — no `getOptionPositions` exists; `robinhood.ts:1080-1115` fetches chains/instruments, not account positions (`docs/design/exit-strategy-intelligence.md:85`)
- P2: Corrected 8-K trigger producer citation — `sec8k.ts:11-30` → `src/lib/web-sources/sec8k.ts` at the material-events boundary (~648-666) (`docs/design/exit-strategy-intelligence.md:88`)

## Why
Codex review (chatgpt-codex-connector[bot]) was submitted 4 min after PR #1688 merged.
These two findings were clear doc correctness bugs; the remaining two P1 items (PLAN.md/phase-doc
update; paper-verification-gate conflict) involve design decisions deferred to the maintainer.

## Files
- `docs/design/exit-strategy-intelligence.md` (2 doc fixes)
- `STATUS.md` (annotation for residual-fix PR)

## Verification
- `npm run lint` — 0 errors
- `npx tsc --noEmit` — clean
- `npm test` — 4665 passed, 402 files
- `npm run build` — clean

## Follow-ups
- **P1**: PLAN.md and docs/phase-7-strategy.md not updated for A/B/C roadmap — awaiting maintainer input
- **P1**: Paper-verification gate in Phase B4 conflicts with owner's prior decision (`docs/capability-trading-roadmap.md:71-74`) — awaiting maintainer input
