# 2026-07-05 — Logo concept exploration (docs-only)

## Summary

Owner asked for a number of logo ideas for **Socratic Trade** (some as
**Socratic.Trade**), with emphasis on options that aren't busy and where the
words are clear and fill most of the logo, plus some free-form directions.

Added `docs/branding/` with ten concept comps:

**Wordmark-led** (the name is the logo)
- **A · Full Stop** — `Socratic.Trade`: bold "Socratic" / light "Trade" split
  by a green geometric dot; the domain itself as the mark.
- **B · Inscription** — wide-tracked serif capitals, classical read without
  Greek-column clichés; small green "TRADE" under a hairline rule.
- **C · Dialogue** — two staggered italic serif lines set like printed Plato:
  green quotation dash, reply line, green full stop.
- **D · Trendline** — letterspaced caps over one thin rising line ending in a
  price dot (quiet descendant of the current favicon).
- **E · Delta** — stacked caps; the A of TRADE is a green delta.

**Mark-led** (symbol survives alone at favicon size)
- **F · Open Question** — question mark whose dot is a green candlestick.
- **G · Sigma** — one stroke that is a sigma, an S, and a zigzag price path.
- **H · Argument** — speech bubble holding a rising chart line.
- **I · Monogram** — serif `S.T` with the green period; small caps beneath.
- **J · Continuity** — the existing `public/icon.svg` unchanged, given a
  proper wordmark lockup.

## Why / decisions

- Palette deliberately reuses the product's existing brand tokens rather than
  inventing a new one: ink `#0f1722`, accent green `#0e9f6e` (light) /
  mint `#63e6be` (dark), dark ground `#0b1018` — from `app/globals.css` and
  `public/icon.svg`. A logo pick therefore requires no app-wide recolor.
- Comps keep type "live" (Helvetica Neue / Georgia stacks + `textLength`)
  instead of hand-outlined paths so they stay cheap to iterate; the chosen
  direction must be redrawn with outlined letterforms before shipping.
- Suggested shortlist noted on the board: **A, D, F, G** (each passes a
  16 px favicon and black-and-white test).
- Docs-only: nothing in the app references these files; `public/icon.svg` and
  all app chrome are untouched.

## Files

- `docs/branding/README.md` (new)
- `docs/branding/logo-concepts.html` (new — self-contained board, both grounds)
- `docs/branding/logo-concepts/{a-full-stop,b-inscription,c-dialogue,d-trendline,e-delta,f-open-question,g-sigma,h-argument,i-monogram,j-continuity}.svg` (new)
- `STATUS.md` (new snapshot entry)
- `docs/EFFORT-LOG.md` (new In Progress row; the `/Users/jay/apps/` live board
  is not reachable from this cloud container — mirror the row there on the next
  local session)
- `docs/rollouts/2026-07-05-logo-concepts.md` (this note)
- `PLAN.md` unchanged — no scope/timeline/approach change.

## Verification

Rendering verified by screenshotting `logo-concepts.html` with headless
Chromium (`/opt/pw-browsers/chromium --headless --screenshot`) on light and
dark tiles; bubble-tail and candle-wick geometry fixed from the first pass.

Repo gate (docs-only change, run per protocol, all green in this session):

```bash
npm run lint       # 0 errors, 308 grandfathered warnings
npx tsc --noEmit   # clean
npm test           # 254 files / 2465 tests passed
npm run build      # exit 0
```

## Follow-ups

- Owner picks a direction (or asks for another round mixing elements).
- Winner: redraw with outlined letterforms; produce favicon/app-icon (replace
  or evolve `public/icon.svg`), horizontal + stacked lockups, mono/one-color
  variant; then wire into app chrome and OG images.
- Mirror the effort row to `/Users/jay/apps/TRADING-EFFORT-LOG.md`.
