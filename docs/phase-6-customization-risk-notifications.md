# Phase 6 - Customization, Risk Rules, Notifications

## Goals

- Add named strategy profiles.
- Persist policy JSON, prompt text, scoring weights, and active profile selection.
- Enforce deterministic risk rules in code.
- Send configured notifications and audit notification outcomes.

## Profiles

Each `StrategyProfile` stores:

- id, name, created/updated timestamps
- policy snapshot
- prompt text
- scoring weights
- active flag

The existing global policy and prompt are migrated into a default profile.
`strategy_profiles` carries a `user_id` column added via the `migrate()` backfill
in `src/lib/db.ts` (same pattern as other per-user tables).

## Risk Rules

As of 2026-07-13, daily opening spend is an explicit either/or control:
`maxDailyPctOfNav` (20% default) or `maxDailyNotional`. The selected mode is normalized on web,
mobile, profile, and AI-review writes, then resolved once through `src/lib/policy-caps.ts` for
strategy generation, deterministic review, broker-minimum bumps, approval-time rechecks, and UI
utilization. Migration v26 changes only the exact former $500 product default to 20% NAV; other
dollar values remain owner-selected dollar mode.

iOS Guardrails (owner cut 2026-08-17) edits the same exclusive caps in either
direction: Ask-First ↔ Autopilot, raise or lower notional, and edit or switch
the binding % of NAV cap.  Returning to Autopilot types `AUTOPILOT`.  Raising a
cap or switching modes on a live account types `CONFIRM` when typed-confirm is
on.  IRA / Roth tax cards show same-account wash sales as not applicable and do
not render the taxable Wash-Sale Guard as On.  User-facing iOS copy is ordinary
  app language: `__rotate__` reads as lowercase “rotate models”; route names,
command types, SSE/APNs, and console-only notes stay out of the UI.

Included-index storage slugs (`sp500`, `nasdaqComposite`, …) stay on
`IndexUniverse` / `includedIndices`.  Every user-facing Indices surface
(Guardrails selected-set and checkbox grid, policy-diff, Scan
`${id}-universe` chips, iOS Guardrails, Desk Current Policy) uses
`indexUniverseLabel` / `formatIndexUniverseList` /
`DeskCopy.joinedIndexList` (`S&P 500`, `Nasdaq Composite`, `Dow 30`,
`NYSE Composite`, …).  Snapshot / API payloads are unchanged.  iOS empty-universe
copy uses that same `S&P 500` example and points at Guardrails (web's
`/console/guardrails`), not a Strategy page the phone does not have.

Policy enforcement includes:

- sector exposure caps for buys
- stop-loss protection for adding to losing positions
- take-profit protection for adding to extended winners
- trailing stop enforcement via the synthetic-stops engine (`src/lib/synthetic-stops.ts`)

## Notifications

Supported events:

- fill
- block
- run_failed
- pending_approval
- kill_switch

Multi-channel delivery is implemented (`src/lib/notify.ts`, ported from Atlas):
phone push (ntfy / Pushover), webhook, email (Resend), and SMS (Twilio). Each
channel is independently gated — disabled unless admin config is present AND the
user has a matching target. No configured channel means the event is audited as
skipped, not failed.

Legacy strategy/feed events still call `sendNotification(...)` so the
`notification_events` table and Activity feed semantics stay intact. That legacy
path now also mirrors enabled events into direct delivery for email/push/SMS
(and direct webhook only when a legacy policy webhook is not already configured),
skipping `price_alert` and `provider_degraded` because those flows already call
the direct dispatcher explicitly.

## Acceptance

- Active profile controls policy and prompt used by strategy runs.
- Dashboard can switch profiles and update profile-backed policy fields.
- Risk-rule blocks include clear reasons.
- Legacy strategy/feed notifications are stored in `notification_events`; direct
  channel delivery is mirrored in audit events (`notify.sent` / `notify.error`).
