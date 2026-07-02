# 2026-07-02 - console-macro

## Summary

- New `/console/macro` destination (parity-port Wave 2): the macro / market-regime
  board, ported from the legacy `app/ui/macro-panel.tsx` and improved. New files
  only, all under `app/console/macro/`:
  - `page.tsx` — the page: regime card, ~90d trend sparklines, five indicator tile
    sections (Rates & yield curve, Inflation & growth, Risk & volatility,
    Positioning & factor regime, Liquidity & economy), full-market breadth with
    top gainers/losers, market news, and a sources footer.
  - `indicators.ts` — pure indicator definitions. Every tile carries a
    plain-language "what this is" line plus, where a real threshold exists
    (inverted curve, VIX bands, HY-spread bands, SKEW, real rates, ERP, breadth,
    claims, …), a dynamic one-line interpretation of the CURRENT reading. Also the
    per-regime meaning copy, the "how the strategist uses the regime" bullets, and
    the trend-series definitions.
  - `trends.tsx` — token-only SVG sparklines for the trailing ~90-day histories
    (tenY, twoY, vix, hyCreditSpread, usd, wti) with polarity coloring (rising
    VIX/credit spread renders negative; direction-neutral series stay muted).
- Improvements over the legacy panel:
  - The current market regime is the page's hero: big label, severity chip
    (escalation / calm / normal / no data), plain-words meaning, the two
    classifier inputs (VIX band + 10Y−policy curve with inversion callout), the
    user's realized per-regime scorecard stat for the current regime (linked to
    Results), and a disclosure explaining exactly where the label changes
    strategist behavior (proposal stamping, thesis-x-regime sizing, Risk-Off/
    Crisis below-median-buy veto + crisis/inverted exposure cap, flip-triggered
    runs) — all verified against `src/lib/macro.ts`, `regime-watch.ts`,
    `policy.ts` (`crisisMaxOpeningExposurePct`), and `strategy.ts`
    (`selectThesisStat`, Rule 3 veto) before writing the copy.
  - Every tile is rendered (legacy hid missing ones); missing values show an
    em dash with "Not available in this snapshot." — never a fabricated number.
  - Honest unsourced-macro handling: when `macro.asOf === "unavailable"` (no FRED
    key AND the key-free VIX fetch failed) the FRED-derived tiles are blanked and
    a warning explains why, instead of rendering the backend's `DEFAULT_MACRO`
    placeholder constants as if they were data (legacy displayed them).
  - Owner UX standard applied: native `title` tooltip on every data point, label,
    chip, section header, link, and news row; `.con-row` hover/focus highlight on
    every tile/row; light + dark via `--con-*` tokens only; responsive 2/3/4-col
    grids for mobile.
  - Non-blocking error notice on the page when the snapshot poll is failing (last
    good data stays rendered), plus an honest empty state if the snapshot carries
    no `macroBoard` at all.

## Why

- Parallel-agent parity port of legacy dashboard features into the ground-up
  `/console` UI (foundation PR #321 already links `/console/macro` in the nav —
  this fills the dead link). The board explains the exact macro inputs the
  strategist conditions on, so the owner asked for per-indicator plain-language
  explanations and a prominent regime treatment rather than a raw tile dump.

## Files

- `app/console/macro/page.tsx` (new)
- `app/console/macro/indicators.ts` (new)
- `app/console/macro/trends.tsx` (new)
- `STATUS.md`, `PLAN.md`, `docs/rollouts/2026-07-02-console-macro.md` (handoff)

No shared/console-foundation files were touched (hard constraint of the parallel
wave): no `console.css`, `nav.tsx`, `lib/api.ts`, no `src/lib/*`.

## Verification

- `npx tsc --noEmit` — clean (the known `test/alternative-data.test.ts`
  mockFetcher error did not reproduce in this worktree).
- `npm run lint` — 0 errors (284 pre-existing grandfathered warnings, none in
  `app/console/macro/`).
- `npm test` — 2241 tests / 234 files, all pass.
- `npm run build` — success; `/console/macro` present in the route manifest as ○.
- Runtime smoke: `next start` on :3111 with a scratch `DATABASE_URL`;
  `GET /console/macro` → 200; `GET /api/dashboard` inspected — live `macroBoard`
  shape confirmed (`regime: "Cautious (Inverted Curve)"`, macro/derived/signals
  keys as typed, empty `history`/`news` without a Massive key).

## Follow-ups

- Backend "light macro" path is client-indistinguishable from fully sourced data:
  with no FRED key but a successful Yahoo VIX fetch, `fetchMacroData` returns
  DEFAULT_MACRO constants for every non-VIX field with `asOf` = today
  (`src/lib/macro.ts`). The console can only blank the fully-`unavailable` case.
  Fix belongs in src/lib (owned by another agent): per-field sourcing flags or an
  explicit `macroSource: "fred" | "vix-only" | "none"` on the board payload.
- Ticker chips in Market news and breadth movers are plain text (no
  `<SymbolButton>` drilldown) — the drilldown needs scan-quote wiring owned by
  the `/console/scan` agent; wire up after both waves land.
- Regime scorecard match relies on exact label string equality between
  `determineMarketRegime` output and persisted `entryMarketRegime` — true today;
  revisit if the label set in `src/lib/macro.ts` is ever renamed.
