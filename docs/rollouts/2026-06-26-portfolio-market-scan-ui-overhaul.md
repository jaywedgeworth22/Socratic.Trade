# 2026-06-26 — Portfolio / Market-Scan / Settings / Help mobile-UX overhaul (+ data & execution fixes)

Branch `claude/portfolio-market-scan-ui-27azkz`. Large operator-driven UX + correctness pass covering
the dashboard header, Portfolio, Market Scan, Congressional/Insider panels, System Help, Settings,
Accounts/Edit-Account, plus several backend correctness fixes. Worked as a team: backend + shared
structural edits landed first (this base), then per-region UI edits fanned out to Sonnet/Haiku/Opus
subagents in isolated worktrees and merged back.

## Summary (what changed)

### Backend / correctness (base commit)
- **Future-dated trades are now an error.** `congress.ts` adds `normalizeTradeDate()` (reuses
  `saneIsoDate`/`toIsoDate`) and `coerceCongressTrade()` rejects any trade whose date is in the future
  (or unparseable). `sec.ts` adds `saneFilingDate()` used by `parseForm4Xml()` + `coerceInsiderFiling()`
  so a future-dated Form 4 (the "Steve Cohen 12/26/2026" bug) is dropped rather than displayed.
- **Market-scan universe = top-N + up to N outliers + holdings.** `market.ts` no longer swaps outliers
  *into* the candidate cap; the candidate set is now the full top-N (`candidateLimit`, default 30) PLUS up
  to `outlierReserve` (default 8) outliers, PLUS any current portfolio holdings not already included.
  Outliers now also include **statistically extreme** names (intraday move or volume in the right tail,
  mean+2σ) via new `tailThreshold()` + `isStatisticalOutlier`, not just web-signal names.
- **Shared-pool contribution defaults ON.** `db-settings.ts` `contributeShared` default `false → true`.
  Tests updated (`learned-context.test.ts`, `learned-context-sharing.test.ts`).
- **Alpaca "Account mismatch" hardened.** `alpaca.ts` `getPortfolio` now compares account numbers
  case/whitespace-insensitively and only throws on a genuine cross-account mismatch (both present and
  different), with an actionable, capitalized "Account Mismatch: …" message instead of bare
  "Account mismatch". Fixes spurious mismatches that aborted autonomous runs (no trades executing).

### Shared structural UI (base commit)
- `overlays.tsx`: large modals (lg/xl/full) now fill the whole screen on mobile (`max-sm` fullscreen +
  edge-to-edge), fixing right-edge clipping on Settings / System Help / Edit-Account.
- `dashboard-client.tsx`: added lucide icons (Columns3, SlidersHorizontal, ChevronDown, Server, Eye,
  EyeOff) centrally; dropped the redundant Settings subtitle and the Accounts "Connect and switch…"
  subtitle (so it no longer mis-describes the Edit view); System Help modal enlarged to `xl`.

### Per-region UI (team subagents — see following commits)
Congress/Insider borders + "Congress.Trade" casing + time-period subtitle; Portfolio Brokerage tag
green + mobile positions list; Readiness drops the broker chip; header mobile layout; Market Scan
mobile + column/settings icons; System Help rebalance (MCP vs REST, de-emphasize Fintech Studios,
fix $Unlimited + "Settings → Operate"); Settings definitions-at-bottom + "Safety" rename + Docs→icon +
Effort capitalization + compact-banner option; Accounts/Edit-Account copy + required fields + Hide Test
Account; Notifications "not configured" copy.

## Files (base)
- src/lib/web-sources/congress.ts, src/lib/web-sources/sec.ts, src/lib/market.ts,
  src/lib/db-settings.ts, src/lib/alpaca.ts
- app/ui/overlays.tsx, app/dashboard-client.tsx
- test/learned-context.test.ts, test/learned-context-sharing.test.ts

## Verification
- `npx tsc --noEmit` clean (after `npm ci`).
- `npx vitest run` congress/market/universe-floor/learned-context/sec/alpaca subsets pass.
- Full trio (tsc/test/build) re-run after the team's region edits merge.

## Notes / decisions
- S&P 500 + Nasdaq 100 = **515** is correct (502 + 101 − 88 overlap, deduped union). No change.
- Sharing-default flip is an explicit owner request; only fact-tier structural market facts are ever
  shared (PII excluded, risk/strategy directives never auto-shared).

## Follow-ups
- The Alpaca mismatch fix addresses spurious/formatting mismatches; if a genuine wrong-number is stored
  the run still surfaces the actionable message (by design). A deeper trace of where the run sources the
  account number vs. the snapshot is a possible follow-up if mismatches persist.
