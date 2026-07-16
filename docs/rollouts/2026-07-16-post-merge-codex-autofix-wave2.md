# 2026-07-16 — Post-merge Codex autofix for ST-audit exec wave 2 (PR #1668)

## Summary

Codex reviewed PR #1668 after it merged (branch deleted) and posted 7 P2 findings. This
follow-up branch addresses 3 of 7 — the clear, directly-actionable correctness/logic fixes.

## What changed

### 1. Require signed samples before reweighting (`src/lib/retrieval-usefulness.ts`)

`usefulnessMultiplier` checked `stat.samples >= USEFULNESS_MIN_SAMPLES`, but `samples` includes
flat/zero-return outcomes. With 5 total samples but only 1 signed (direction-indicating) win/loss,
the condition was satisfied by total count — the max ±10% rank nudge could fire on a single
directional observation.

**Fix:** compare `signed` (wins + losses) against `USEFULNESS_MIN_SAMPLES` instead of `samples`.
Now requires 5 signed observations before a kind's multiplier deviates from neutral.

### 2. Contain calendar event names before prompting (`src/lib/strategy.ts`)

FMP economic-calendar `event` names were injected into the prompt verbatim without:
- `containData()` sanitization (unlike every other third-party text block in the prompt)
- An entry in `untrustedPromptFields` for the advisory injection scan

**Fix:** wrapped `event.event` with `containData("news", "economicEvent", ...)`, matching the
pattern used for external-news headlines, and added a `"economicCalendar"` entry to
`untrustedPromptFields`.

### 3. Bound Quiver requests with a timeout (`src/lib/quiver-provider.ts`)

`QuiverEnrichmentProvider.getRows` made HTTP fetch calls with no `AbortController` signal. A
hung Quiver endpoint could hold the whole `enrich()` batch (all 5 per-symbol subfetches) until
the platform/network timeout, blocking downstream strategy runs.

**Fix:** added `new AbortController()` with a 10s timeout per subfetch, matched to the pattern
used by other provider calls in `data-providers.ts`. The timeout is cleared in `finally`.

## Files touched

- `src/lib/retrieval-usefulness.ts` — signed-samples threshold fix
- `src/lib/strategy.ts` — containData + untrustedPromptFields for economic calendar events
- `src/lib/quiver-provider.ts` — 10s AbortController timeout
- `STATUS.md` — new entry for this autofix
- `docs/rollouts/2026-07-16-post-merge-codex-autofix-wave2.md` — this note
- `package-lock.json` — `npm install` collateral

## Verification

- `npx tsc --noEmit` — clean
- `npm test` — 400 files / 4596 tests passed
- `npm run build` — clean
- `npm run lint` — 0 errors

## Deferred items (maintainer asked — architecturally significant)

1. **Replace stale calendar rows during refresh** (`economic-calendar.ts`): stale future rows from
   a previous ingest persist after a refresh returns different data.
2. **Use strategy run window for liveness** (`trading-liveness.ts`): hard-codes regular-session
   `isMarketOpen` instead of checking the account's `runDuringExtendedHours` policy.
3. **Scope usefulness weights to connected account** (`experience-memory.ts`): usefulness re-rank
   reads stats by `userId` only, potentially bleeding signal across accounts.
4. **Avoid crediting decisions before all horizons mature** (`retrieval-usefulness.ts`): early
   terminal status marks the whole decision credited before later horizons resolve.

## Follow-ups

- Create a PR for this branch
- Post a comment on the original PR #1668 linking to the new PR
- Resolve the Codex threads on PR #1668 for the items fixed here
