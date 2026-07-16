# 2026-07-16 — Settings de-iOS restoration, admin integration, Configure IA, site-wide UI review (MONET)

## Summary

Owner escalation: "nobody is able to make the Settings page look half decent… it looked
10 times better 3 days ago… it looked like all the other parts of the site." Root cause
identified by git archaeology, fixed by restoration rather than another reskin, plus the
owner's three structural asks (admin link at top of site, admin portal that feels like
the same app, more intuitive Configure tabs), driven by a 7-expert multi-agent UI review
of every console surface.

## Root cause (why every previous "fix" showed ~zero improvement)

- 2026-07-12 `d236f9d6` (PR #1476, "iOS UI refresh") converted the Settings page AND all
  seven sub-card modules from the console design system (`Card`/`Field`/`Toggle`/`Chip`
  from `app/console/ui/primitives.tsx`) to new iPhone-Settings-style components
  (`app/ui/ios-components.tsx`: List/ListSection/ListRow/LabeledContent — full-width rows,
  control pinned far right, chevrons). Settings stopped matching every other page.
- The two subsequent "fixes" — `bb2a…` #1535 (theme tokens) and `001d8af0` #1651
  (con-card outer containers + SettingsGroup) — only reskinned the CONTAINERS. Row
  internals stayed iOS, so the page still didn't read like the rest of the site.
- Concrete regression evidence (screenshots in the PR): current desktop-light Settings
  is 7,003px tall vs 5,325px on July 11 (+31%) with only ~6 genuinely new controls;
  event notifications became ~18 full-width single-column iOS toggle rows labeled with
  RAW snake_case event ids (`run_failed`, `kill_switch`, `autonomy_halted_on_boot` …),
  7 of 18 with no explanatory hint at all, vs July 11's compact two-column plain-English
  checkbox grid.

## What changed

(filled in as workstreams land)

1. **Settings de-iOS restoration** — every settings module restored to its `ffdc9d1f`
   (July 11) console-primitive architecture with ALL post-July-11 content ported forward:
   - `api-keys.tsx`, `delivery.tsx`, `sharing.tsx`, `help.tsx`: zero content drift since
     July 11 (verified per-commit) — verbatim restorations.
   - `brokers.tsx`: restoration + #1492 (Exit Replacement blockers) and #1544 content;
     the #1544 Test-Account-button removal is deliberate product direction and was
     preserved (not resurrected).
   - `danger.tsx`: restoration + #1492 `activeReplacements` deletion-blocker.
   - `learning-review.tsx`: restoration + #1544 model options + #1631 threshold/max-wait
     knobs and the save()-reports-success fix.
   - `page.tsx`: July-11 shell (Chip-labeled scope sections, two-column event grid) +
     complete plain-English `EVENT_LABEL`/`EVENT_HINT` maps for all notification event
     types (typed `Record<NotificationEventType, …>` so a future event type without copy
     is a compile error, not a snake_case leak).
   - `app/ui/ios-components.tsx` DELETED (grep-verified zero remaining imports).
2. **Admin at top of site** — admin-only `Admin` link (ShieldCheck) in the desktop
   ChromeBar + `Admin portal` entry in the UserMenu (phone path), gated on
   `snapshot.currentUser?.isAdmin`.
3. **Consent-gate decline now sticks** — `GET /api/consent` computed `needsConsent` as
   "not accepted", so a recorded DECLINE re-prompted the blocking dialog on every console
   load, contradicting the gate's documented semantics. Any recorded answer at the current
   consent version now resolves the gate; actual pooling stays gated on explicit accept
   (`hasDataPoolConsent` unchanged).
4. **Admin portal restyle** — (pending workstream)
5. **Configure IA** — (pending workstream)
6. **Site-wide quick wins** — (pending workstream)

## Why

Owner-directed (2026-07-16 session). Design decisions came from a 7-expert parallel
review workflow (settings restoration, configure IA, admin integration, core surfaces,
review surfaces, mobile+dark, design language) + design-lead synthesis; specs are
session artifacts, key conclusions recorded here and in the PR description.

## Files

(exact list at land time — `git diff --stat main...`)

## Verification

(exact commands + results at land time; includes full-page screenshot re-shoot of all
16 pages × desktop-light/desktop-dark/mobile-light and acceptance-criteria review)

## Follow-ups

(deferred findings backlog at land time)
