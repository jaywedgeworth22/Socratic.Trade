# 2026-07-05 — Logo concept exploration (12 marks)

## Summary

First brand exploration for Socratic.Trade: twelve logo concepts crossing the
Socratic half of the name (question, dialogue, examination, Greek antiquity)
with the trading half (candlesticks, trend lines, delta). Delivered as:

- `docs/branding/logo-ideas.html` — self-contained, theme-aware showcase page
  (each mark previewed on light AND dark chips with a favicon-scale copy,
  plus two lockups and a studio recommendation). This file is the source of
  truth: every mark is an SVG `<symbol>`.
- `docs/branding/logo-ideas/*.svg` — 12 standalone SVGs extracted from those
  symbols (`inquiry`, `phi`, `examined`, `meander`, `dialectic`, `stoa`,
  `noctua`, `delta`, `laurel`, `serpentine`, `torch`, `wordmark`).
- `docs/branding/logo-ideas.md` — concept index, shared design rules, and the
  regeneration one-liner.

## Why / decisions

- User request ("make numerous logo ideas for this app") on branch
  `claude/logo-ideas-c5n61b`.
- All marks share one discipline: single ink color (`currentColor`) + the
  dashboard's existing emerald accent `#0e9f6e`, so any pick drops into the
  current UI tokens without a new palette. Rose `#e11d48` appears only in
  The Examined Trade (a red candle under the lens — deliberate).
- Recommendation recorded in the doc: **Phi** for app icon/favicon,
  **The Inquiry** for storytelling surfaces, **The Examined Trade** for
  reports.
- `PLAN.md` intentionally NOT changed: this is a design side-deliverable, no
  scope/timeline/approach change to the phased roadmap.

## Files

- `docs/branding/logo-ideas.html` (new)
- `docs/branding/logo-ideas.md` (new)
- `docs/branding/logo-ideas/{inquiry,phi,examined,meander,dialectic,stoa,noctua,delta,laurel,serpentine,torch,wordmark}.svg` (new, generated)
- `STATUS.md` (Active Focus entry)
- `docs/rollouts/2026-07-05-logo-ideas.md` (this note)

## Verification

- Rendered the showcase with headless Chromium
  (`/opt/pw-browsers/chromium --headless --screenshot ...`) and visually
  verified all 12 marks + lockups on both light and dark chips at full and
  favicon scale.
- Extraction script run; 12 SVGs written and listed.
- `npx tsc --noEmit` — clean.
- `npm test` — 776 passed / 1 failed (777, 86 files). The single failure is
  the KNOWN pre-existing date-sensitive `test/cache-provenance.test.ts`
  cross-user-leak assertion (documented in STATUS.md since 2026-06-21);
  unrelated — this change touches no `src/`, `app/`, or `test/` files.
- `npm run build` — green (full Next.js production build).
- (Cloud VM: fresh `npm install` first — no `node_modules` in a fresh clone.
  Incidental `package-lock.json` libc-field churn from older npm was reverted,
  not committed.)

## Follow-ups

- Owner to pick a direction (or ask for iterations on a shortlist); then cut
  proper exports (app icon sizes, favicon.ico, OG image) and wire into
  `app/layout.tsx` metadata.
- The wordmark SVG uses a serif font stack (`Iowan Old Style → Palatino →
  Georgia`), so its exact rendering is platform-dependent; a chosen final
  wordmark should be converted to outlined paths.
