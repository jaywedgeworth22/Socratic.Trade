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

## Risk Rules

Policy enforcement includes:

- sector exposure caps for buys
- stop-loss protection for adding to losing positions
- take-profit protection for adding to extended winners
- optional trailing stop metadata for future broker reconciliation

## Notifications

Supported events:

- fill
- block
- run_failed
- pending_approval
- kill_switch

Webhook delivery is disabled unless a webhook URL is configured. No webhook means the event is audited as skipped, not failed.

## Acceptance

- Active profile controls policy and prompt used by strategy runs.
- Dashboard can switch profiles and update profile-backed policy fields.
- Risk-rule blocks include clear reasons.
- Every notification attempt is stored in `notification_events` and mirrored in audit events.
