# 2026-08-04 — UX PR-D4 PWA polish pass

## Context & Objective

Owner-directed Wave D slice from `docs/design/ux-improvement-program.md` §PR-D4: polish the
`/mobile` PWA so command history and authority read like the rest of the product (not raw wire
enums), offline/stale states warn without freezing the remote, and the surface is honestly labeled
as a control remote with the full desk on desktop.

## Changes Made

High level:

1. **Humanize command type labels** — `commandLabel()` maps known mobile command types
   (`strategy.run_once` → “Run once”, `proposal.approve` → “Approve proposal”, etc.) for the
   active-command chip and Command Log. Unknown types title-case segments with ` · ` separators
   (never raw `foo / bar_baz`).
2. **Authority glossary** — Mode card shows `authorityLabel()` (“Ask-first” / “Autopilot”) with
   tooltip titles from `app/console/lib/labels.ts`, not raw `propose`/`decide`.
3. **Stale/offline banners; controls stay usable** — Once a snapshot has loaded, refresh/stale
   no longer set `canSubmit=false` (that used to disable Run/Approve on every poll). Banners warn
   that data may be stale; offline still blocks posts; Stop/account-switch unchanged online path.
4. **Header note** — “Control remote — full desk on desktop” under the title (program §PR-B5 /
   D4 remote positioning).
5. **Proposals queue title** — Section heading “Approvals” → “Proposals” (aligns with console/iOS
   and PR-A5 if it lands separately).

Files touched:

- `app/mobile/mobile-pwa-client.tsx`
- `test/mobile-pwa-client.test.tsx`
- `STATUS.md`, `docs/EFFORT-LOG.md`, this rollout note
- Live board: `/Users/jay/apps/TRADING-EFFORT-LOG.md`

## Decisions & Trade-offs

- **Freshness no longer freezes trading controls.** Previous gate required
  `freshness === "fresh"` for `canSubmit`, which disabled Run/Approve during every snapshot
  refresh and after a failed poll. Product intent for a remote control: warn with a banner, keep
  controls usable while online; server remains authoritative for conflicts. Offline still blocks.
- **Shared `authorityLabel` import** from console labels keeps Ask-first/Autopilot vocabulary
  single-sourced (same as Activity/trace).
- **Proposals rename** is intentionally the user-facing section title only; route
  `/console/approvals` and internal `pendingProposals` identifiers stay.

## Verification State

```bash
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
npx tsc --noEmit
npx eslint app/mobile/mobile-pwa-client.tsx test/mobile-pwa-client.test.tsx
npx vitest run test/mobile-pwa-client.test.tsx
```

(Host load from parallel agent npm installs may defer local runs; CI `verify` is authoritative
for full suite + build.)

## Next Steps & Blockers

- Residual Wave D: **PR-D3** iOS command outcome feedback parity (if not already covered).
- Optional: unit-test banner copy via static render if product wants string locks.
- Merge auto-deploys production (`socratic-trade-prod`).

## Zero-Code Findings

None — code changed.
