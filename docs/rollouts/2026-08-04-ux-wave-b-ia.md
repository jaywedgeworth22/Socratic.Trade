# Rollout: UX Wave B IA (B1 plain nav, B2 Autonomy panel, B4 Settings TOC)

## Context & Objective

Implement Wave B slices from `docs/design/ux-improvement-program.md` under owner D2
default (plain destination labels). Goal: more intuitive rail nouns, one place to
answer “is the agent on and why not?”, and sticky jump chips on Settings — without
changing policy defaults or clobbering PR-A4 Advanced disclosure work.

## Changes Made

- **B1 plain nav labels** on the console rail (`DESTINATIONS`): Thesis→**Home**,
  Evidence→**Scan**, Journal→**Activity**, Outcomes→**Results**, Regime→**Macro**.
  Hover `desc` strings keep the sophisticated metaphor.
- **h1 / in-page links** for renamed destinations go through `destinationLabel()` so
  rail and titles cannot drift (Home page h1 added; Home→Activity/Results links updated).
- **Mobile default tab comment** updated (pins remain href-keyed — rename-safe).
- **B2 Autonomy surface** on Guardrails: status grid (run state / authority / cadence),
  same chrome `RunOnceButton` + `RunStateButton`, readiness from exported
  `deriveRunBlock`, authority ritual unchanged. Anchors: `#autonomy` and `?focus=autonomy`
  (hash scroll after snapshot load).
- **B4 Settings sticky TOC**: jump chips for Notifications / Display / Sharing / Danger
  with existing section anchors (`scroll-mt-28`).
- **B3 Strategy progressive structure**: intentionally **skipped** this PR.
- Unit test: `test/console-nav-labels.test.ts`.

### Touched files

- `app/console/components/nav.tsx`
- `app/console/components/chrome.tsx` (`deriveRunBlock` export only)
- `app/console/lib/mobile-tabs.ts`
- `app/console/page.tsx`
- `app/console/guardrails/page.tsx`
- `app/console/settings/page.tsx`
- `test/console-nav-labels.test.ts`
- `docs/rollouts/2026-08-04-ux-wave-b-ia.md`
- `docs/EFFORT-LOG.md`, `STATUS.md`

## Decisions & Trade-offs

- D2 silent default: **plain labels** (not dual “Home · Thesis”).
- Autonomy lives on **Guardrails** (not Strategy), matching program preference.
- Run controls are **reused** from chrome — no second control path / no policy default edits.
- Did **not** flip Advanced rulebook / `AdvancedGroup` `defaultOpen` (PR-A4 keepout).
- B3 left out to keep this PR IA-focused and merge-safe.

## Verification State

```bash
# Node 24 per .nvmrc
npm run lint
npx tsc --noEmit
npx vitest run test/console-nav-labels.test.ts
npm test
npm run build
# then
bash scripts/land.sh
```

(Fill exact results at land time.)

## Next Steps & Blockers

- Optional follow-ups: Wave A (A1–A5), B3 Strategy structure, Wave C speed, Wave D mobile.
- Peers on `trading-grok-ux-b1` / partial B1-only trees should discard or rebase onto this
  branch once merged — this worktree is source of truth for Wave B.

## Zero-Code Findings

None beyond confirming D2 default plain labels and B3 out of scope.
