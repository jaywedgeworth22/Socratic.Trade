# 2026-07-09 — Stop-loss settings accuracy: extended-hours exit routing + honest coexistence label (MONET)

Branch: `monet/stop-loss-settings-defaults-759d07`

## Summary

First slice of an owner-directed stop-loss **settings-accuracy** effort (audit found several stop
toggles that behave differently than their labels imply). This slice ships the two parts that are
**non-overlapping** with the parallel Monet/Antigravity PRs also touching the guardrails surface:

1. **Extended-hours protective-exit routing fix** — the "App stops in extended hours"
   (`allowExtendedHoursSyntheticStops`) toggle was not just mislabeled, it was **broken**:
   `alpaca.ts` set `extended_hours=true` on a still-`market` order, which Alpaca rejects (extended
   orders must be DAY limit orders), and the MCP order path dropped the flag entirely. So turning it
   on made the protective exit fail/no-op instead of firing after hours. Per owner ruling
   ("limit when ON, queue when OFF"), protective exits now route through a new shared helper:
   - toggle OFF (default) or a regular/closed session → a plain **market** order tagged
     `regular_hours` (unchanged; an after-hours trigger rests until the 09:30 open);
   - toggle ON **and** the pre/post session → a **marketable-limit** (`type: "limit"`,
     `extended_hours`, DAY) priced through the last quote (a SELL crosses down, a COVER up, by
     `tuning.marketableLimitBufferBps`, default 15) so it can actually fill in thin liquidity.
   Applied to BOTH protective-exit paths: the every-tick synthetic monitor and the proactive
   risk-exit generator. Fails safe (market/queue-to-open) when no price is available or "limit" is
   not a permitted order type.

2. **Honest coexistence protection label** — the per-position protection label
   (`deriveProtection`) showed only the trailing stop when a trailing % was set, implying it
   *replaced* the fixed stop. A fixed stop and a trailing stop actually COEXIST (fixed % drives the
   proactive exit / broker bracket; trailing % drives the synthetic monitor). The label now reads
   `App stop −8% + trailing −5%` when both apply.

## Why

Owner audited the stop settings and asked that they be "obvious in settings and accurate always."
The extended-hours toggle was the sharpest case: enabling it silently broke the protective exit.
Owner chose the marketable-limit fix (real after-hours execution) over queue-to-open, with the
default staying OFF.

## Coordination

A parallel Monet session was mid-build on the overlapping fileset and (via #agent-sync) claimed a
"no gate / labels-only" reading of owner intent. Owner ruled (this session's live conversation is
authoritative): the short-selling **gate stays** and **behavior-match stays**. Division agreed on
the channel: the peer keeps `defaults.ts` (`shortStopLossPct=8` real default, PR #1221),
shorts-surface in Essentials, and the RH resting-state **safety** fixes; this branch keeps the
short-selling gate + ATR/beta/extended-hours label honesty + behavior-matches. Shared files
(`field-defs.ts`, `guardrails/page.tsx`) are deferred here to avoid a 3-way clobber with PR #1221
and Antigravity PR #1211 (extended-hours tooltips).

## Files

- `src/lib/protective-exit-routing.ts` — **new.** `extendedHoursExitBufferBps`,
  `marketableLimitExitPrice`, `resolveProtectiveExitRouting`.
- `src/lib/synthetic-stops.ts` — synthetic monitor exit uses `resolveProtectiveExitRouting` (replaces
  the unconditional `extended_hours` marketHours; adds `limitPrice`).
- `src/lib/strategy.ts` — `generateProactiveRiskProposals` takes an `extHoursBufferBps` param (resolved
  once by the async run via `extendedHoursExitBufferBps(policy)`); the proactive stop/short-stop exit
  becomes a marketable-limit `extended_hours` order when set.
- `app/console/lib/derive.ts` — coexistence protection label.
- `test/protective-exit-routing.test.ts` — **new**, 15 tests (helper + generator wiring).

## Verification

- `npx tsc --noEmit` — clean.
- `npm run lint` — 0 errors (pre-existing warning backlog unchanged).
- `npx vitest run` — **3183 passed** (307 files), including the 15 new routing tests.
- `npm run build` — (in the same run; recorded green before PR).

## Follow-ups (blocked on other in-flight PRs)

- **field-defs honest copy** (ATR needs `stopLossPct>0` + precedence over beta; beta ignored when
  ATR applies; ATR period/multiple show real 14/2.0 defaults + decimal multiple; short-stop gate
  copy) — layer AFTER peer PR #1221 and AG #1211 merge (both touch `field-defs.ts`).
- **short-selling gate** in `guardrails/page.tsx` — inline warning when short selling is on and the
  effective `shortStopLossPct` ≤ 0 (shorts are hard-rejected at `policy.ts:433`); after #1221 lands
  (it moves the shorts fields into Essentials).
- **RH resting stop uses the effective ATR/beta distance** (`broker-protective-stops.ts`, currently
  flat `stopLossPct`) — needs the per-position effective stop % persisted at reconcile time; fold
  into / stack on the peer's RH-safety PR.
- Known: the synthetic monitor still routes `extended_hours` per-session; the RH resting stop and
  Alpaca native bracket stop legs remain regular-hours only (broker-held; separate follow-up).
