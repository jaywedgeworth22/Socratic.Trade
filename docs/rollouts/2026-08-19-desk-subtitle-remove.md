# 2026-08-19 — Remove redundant Home Desk subtitle

## Context & Objective

Owner: iOS Home shows “Coach, Scan, Guardrails, and Results” as text under the **Desk** heading, immediately above the same four shortcut buttons.  That is redundant.  Remove the subtitle.  Do not replace it with helper copy, owner notes, or developer-speak.  Do not rename the buttons.  Do not change tab behavior.

## Changes Made

Investigated iOS and console/web first.

- **iOS:** `DeskShortcutsCard` on Home used `SectionHeading("Desk", subtitle: "Coach, Scan, Guardrails, and Results")` above `Coach` / `Scan` / `Guardrails` / `Results` buttons.  Subtitle removed.  Heading and buttons stay.
- **Console / web:** no matching chrome.  Destinations live in the left rail and page `h1` via `destinationLabel`.  Home has no Desk heading that restates Coach / Scan / Guardrails / Results.  PWA `/mobile` is out of scope and already redirects to `/console`.

Touched files:

- `ios/SocraticTrade/HomeView.swift`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/phase-8-cockpit-ui.md`
- `docs/rollouts/2026-08-19-desk-subtitle-remove.md`

## Decisions & Trade-offs

- Deleted the subtitle only.  Did not invent replacement copy under **Desk**.
- Left button titles and `AppTab` routing alone.
- Did not touch #2848 / #2847 / #2841 / #2840 or strategy/trading paths.
- Did not merge, deploy, or bounce Coolify.

## Verification State

- `rg -n 'Coach, Scan, Guardrails' --glob '!docs/**' --glob '!ios/SocraticTrade/README.md'` — product UI hit is gone (`HomeView.swift` heading is `SectionHeading("Desk")`).
- Linux Cloud VM: no `xcodebuild`.  Swift compile is CI-only for this change.
- No TypeScript / console product files changed, so lint / tsc / vitest / next build were not re-run for this Swift heading delete.

## Next Steps & Blockers

- Review the PR.  Do not merge from this seat.
- Native visual confirm needs a device or simulator screenshot of Home → Desk (heading only, four buttons still labeled Coach / Scan / Guardrails / Results).

## Zero-Code Findings

Console / web does not render a Desk heading with a Coach / Scan / Guardrail / Results subtitle.  The duplicate was iOS Home only.
