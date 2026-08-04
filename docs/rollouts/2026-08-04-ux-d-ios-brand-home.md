# Rollout: UX Wave D — iOS brand teal + Home hero (PR-D1 + PR-D2)

## Context & Objective

Implement **PR-D1** (iOS brand palette parity with web `--brand-accent`) and **PR-D2** (Home readiness checklist + urgency CTAs) from `docs/design/ux-improvement-program.md` Wave D. Native iOS was still on system indigo and buried pending proposals / setup gaps below the fold.

## Changes Made

### D1 — Brand accent
- `AppPalette.accent` is no longer `Color.indigo`.
- Adaptive brand teal matching web tokens:
  - Light: `#12616f` (`--brand-accent`)
  - Dark: `#58c7d3` (`--brand-accent-dark`)
- Login gradients / tab tint / metric defaults that use `AppPalette.accent` pick up the brand hue automatically.

### D2 — Home urgency + hero
- Lifted `selectedTab` as a `Binding` from `MobileControlView` into `HomeView` so Home can switch tabs.
- `AppTab` made module-internal (was `private`) for the binding.
- **Pending proposals:** top CTA card when `pendingProposals.count > 0`; tap sets `selectedTab = .proposals`.
- **Proposals tab badge:** still driven by `pendingProposals.count` (existing `.badge`).
- **Incomplete readiness:** dominant “Finish setup” checklist (account + universe) at top; Account & Settings CTA when account missing.
- **Complete readiness:** hero with equity, unrealized P&L, agent state, and primary **Run once** CTA.
- Agent overview keeps a slim path when setup is incomplete (inline readiness text suppressed to avoid duplicating the checklist).

### Files touched
- `ios/SocraticTrade/AppComponents.swift`
- `ios/SocraticTrade/HomeView.swift`
- `ios/SocraticTrade/MobileControlView.swift`
- `docs/rollouts/2026-08-04-ux-d-ios-brand-home.md` (this note)
- `docs/EFFORT-LOG.md` + `/Users/jay/apps/TRADING-EFFORT-LOG.md`
- `STATUS.md`

## Decisions & Trade-offs

- **No App Icon asset regen in this PR** — AG already landed full-bleed white candlestick icons; D1 here is accent hue only. Icon alignment item from the program doc is already satisfied on main.
- **Top proposals CTA is always shown when count > 0** (even when ready hero is present) so urgency is above-the-fold; ready hero primary remains **Run once** to avoid two identical Review buttons.
- Checklist re-derives from mobile `readiness.hasAccount` / `hasUniverse` only (no LLM key on the mobile snapshot). Matches iOS capability; web A3 can be richer later.
- No backend / mobile API changes.

## Verification State

```bash
cd ios
xcodebuild \
  -project "Socratic Trade.xcodeproj" \
  -scheme SocraticTrade \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/socratic-ios-dd-uxd \
  CODE_SIGNING_ALLOWED=NO \
  ONLY_ACTIVE_ARCH=YES \
  build
```

**Result: BUILD SUCCEEDED** (Xcode 27 / iPhoneSimulator 27.0, `CODE_SIGNING_ALLOWED=NO`).

Web gates (`npm run lint` / `tsc` / `test` / `build`) are N/A for pure Swift UI — no TS/JS path changes. `land.sh` still runs the full verify suite before push.

## Next Steps & Blockers

1. **PR-D3** — iOS command outcome feedback on proposal cards (sending → success/fail).
2. **PR-D4** — PWA polish (humanized command labels, authority glossary).
3. Optional: surface day-realized P&L if/when the mobile snapshot exposes a true session-day field (hero currently uses unrealized P&L from performance).

## Zero-Code Findings

None beyond confirming web brand tokens remain `#12616f` / `#58c7d3` in `app/globals.css`.
