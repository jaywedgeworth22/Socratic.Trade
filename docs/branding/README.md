# Branding — logo concepts (2026-07-05)

Ten logo directions for Socratic Trade, produced as concept comps. Open
`logo-concepts.html` in a browser to see every concept side by side on light
and dark grounds with rationale; the standalone SVGs live in
`logo-concepts/`.

## Palette

Taken from the product's existing tokens (`app/globals.css`, `public/icon.svg`):

- Ink `#0f1722` (light ground) / `#f2f6fa` (dark ground)
- Brand green `#0e9f6e` on light, mint `#63e6be` on dark
- Dark ground `#0b1018`

The standalone SVGs are exported in light-ground colors on a transparent
background; for dark grounds swap ink to `#f2f6fa` and green to `#63e6be`
(the HTML board does this via `currentColor` + a `--lg` CSS variable).

## Concepts

Wordmark-led (words are the logo):

- `a-full-stop.svg` — "Socratic.Trade": bold/light weight split with a green
  geometric dot; the domain itself as the logo.
- `b-inscription.svg` — wide-tracked serif caps, inscriptional/classical read.
- `c-dialogue.svg` — two staggered italic serif lines set like printed
  dialogue: quotation dash, reply, green full stop.
- `d-trendline.svg` — letterspaced caps over a thin rising line ending in a
  price dot (quiet descendant of the current favicon).
- `e-delta.svg` — stacked caps with a green delta/triangle as the A of TRADE.

Mark-led (symbol works alone as favicon/app icon):

- `f-open-question.svg` — question mark whose dot is a green candlestick.
- `g-sigma.svg` — one stroke that is a sigma, an S, and a zigzag price path.
- `h-argument.svg` — speech bubble holding a rising chart line.
- `i-monogram.svg` — serif "S.T" with the green period, small caps beneath.
- `j-continuity.svg` — the existing favicon unchanged, given a wordmark lockup.

## Status / caveats

- These are **concepts, not final assets**: type is set live with
  `Helvetica Neue`/`Georgia` font stacks and `textLength`, so exact rendering
  varies slightly by platform. A chosen direction should be redrawn with
  outlined letterforms before shipping.
- Nothing in the app references these files; `public/icon.svg` is untouched.
