# 2026-06-29 — Page title update

## Summary
Changed the page/tab title from "AI market research & strategy dashboard" to
"Trading Dashboard" in the Next.js metadata (layout) and the welcome page.

## Why
The old title was verbose. "Trading Dashboard" is concise, professional, and
accurately describes the app while fitting cleanly in browser tabs.

## Files touched
- `app/layout.tsx` — 3 occurrences: `metadata.title.default`,
  `metadata.title.template`, `metadata.openGraph.title`
- `app/welcome/page.tsx` — 4 occurrences: `metadata.title`, `metadata.openGraph.title`,
  `metadata.twitter.title`, inline `<title>` in the HTML `<Head>`

## Verification
- `npx tsc --noEmit` — clean (exit 0)

## Follow-ups
None.
