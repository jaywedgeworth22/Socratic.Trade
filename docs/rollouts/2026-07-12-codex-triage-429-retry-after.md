# 2026-07-12 — [codex-autofix] Honor HTTP-date Retry-After values in 429 handling

## Summary
Codex reviewer (chatgpt-codex-connector[bot]) flagged a P2 finding on PR #1475: the existing
429 Retry-After handling in `src/lib/congress-stream.ts` only parsed delta-seconds via
`parseInt`, ignoring the legal HTTP-date format (RFC 7231 §7.1.3, e.g.
`Retry-After: Wed, 21 Oct 2015 07:28:00 GMT`).

## What changed
- Added `Date.parse()` fallback in `connectOnce()` when `parseInt` returns NaN
- Computed seconds-until-reset from the HTTP-date → `Date.now()` delta
- Error message format unchanged — the same `(Retry-After: {seconds})` string is emitted
- `runLoop()`'s existing regex `/HTTP 429 \(Retry-After: (\d+)\)/` continues to extract
  the correct backoff seconds without modification

## Files touched
- `src/lib/congress-stream.ts` — 10 lines added (HTTP-date parsing branch)
- `package-lock.json` — 1-line npm install bump (unrelated)
- `STATUS.md` — status entry added
- `docs/EFFORT-LOG.md` — effort entry added

## Verification
- `npx tsc --noEmit`: clean (no errors)
- `npm test`: 349 files / 3896 tests passed
- `npm run build`: clean

## Thread status
- Codex thread `PRRT_kwDOS7mOVM6QLY92` — **RESOLVED**
- Auto-merge enabled via `gh pr merge --squash --auto`

## Follow-ups
None. This is a focused one-comment autofix.
