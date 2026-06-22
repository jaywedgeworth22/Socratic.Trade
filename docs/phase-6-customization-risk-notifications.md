# Phase 6 - Customization, Risk Rules, Notifications

## Goals

- Add named strategy profiles.
- Persist policy JSON, prompt text, scoring weights, and active profile selection.
- Enforce deterministic risk rules in code.
- Send webhook notifications when configured and audit all notification outcomes.

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

## Acceptance

- Active profile controls policy and prompt used by strategy runs.
- Dashboard can switch profiles and update profile-backed policy fields.
- Risk-rule blocks include clear reasons.
- Every notification attempt is stored in `notification_events` and mirrored in audit events.
