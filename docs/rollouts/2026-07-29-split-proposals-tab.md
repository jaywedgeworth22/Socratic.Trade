# 2026-07-29 Split Proposals and Lessons Tabs

## Context & Objective
The user requested to split the "Proposals" tab into two: one for Trade proposals and one for Lessons. The previous agent implemented this as two entirely separate left-navigation destinations (`/console/approvals` and `/console/lessons`). The user clarified that they wanted UI tabs *inside* the Proposals page itself. This work integrates the Lessons UI into the Approvals page and removes the separate navigation entry.

## Changes Made
- Modified `app/console/components/nav.tsx` to remove the standalone "Lessons" link and update the "Proposals" description.
- Modified `app/console/approvals/page.tsx` to include a top-level tab switcher (Proposals vs Lessons) matching the pattern used in the Activity page. 
- Integrated `<LearnedContextInbox>` and `<LearnedFactsArchive>` directly into the `tab === "lessons"` branch of the Approvals page.
- Deleted `app/console/lessons/page.tsx`.

## Decisions & Trade-offs
- Used standard React local state (`useState<Tab>`) for the tabs instead of URL-based routing (e.g. `?tab=lessons`) to stay consistent with the `app/console/activity/page.tsx` pattern. 
- The right-column `AlertCenter` is hidden when viewing Lessons to give the lessons list full width (which matches its previous standalone layout).

## Verification State
- `npm run build` ran successfully (Next.js compilation + static generation + TypeScript).
- `npx tsc --noEmit` and `npm run lint` passed.

## Next Steps
- Push changes using `scripts/land.sh`.
