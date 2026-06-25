# 2026-06-25 — Robinhood agenticAllowed default fix

## Summary

Fixed a bug where all Robinhood brokerage accounts showed the warning
"Selected broker account is not currently available for agentic execution."

## Why

The Robinhood MCP `get_accounts` response does not include an `agentic_allowed`
or `agenticAllowed` field. The existing code was:

```ts
agenticAllowed: Boolean(item.agentic_allowed ?? item.agenticAllowed),
```

`Boolean(undefined ?? undefined)` evaluates to `false`, so every account was
flagged as ineligible for agentic execution regardless of account type.

An initial fix defaulted to `true` unconditionally, but Codex review (PR #151)
correctly flagged that this would also mark IRA/Roth accounts as agentic, and
that `accounts.find((a) => a.agenticAllowed)` would then select the first account
returned (possibly a read-only IRA) instead of the actual trading account.

## Fix

Default to `accountType === "brokerage"` instead of `true`:

```ts
agenticAllowed: Boolean(item.agentic_allowed ?? item.agenticAllowed ?? (accountType === "brokerage")),
```

The `accountType` derivation already correctly classifies:
- `roth_ira` — brokerage_account_type contains "roth"
- `traditional_ira` — brokerage_account_type contains "ira" or "traditional"
- `brokerage` — everything else (standard trading account)

This means:
- Standard brokerage accounts with no explicit field → `true` (agentic allowed)
- IRA/Roth accounts with no explicit field → `false` (correctly excluded)
- Any account with an explicit `agentic_allowed: false` → still `false` (override respected)

## Files

- `src/lib/robinhood.ts` — line 103, `agenticAllowed` computation
- `STATUS.md` — added entry
- `docs/rollouts/2026-06-25-robinhood-agentic-default.md` — this file

## Verification

```bash
npx tsc --noEmit   # clean
npm test           # 1150/1151 (cache-provenance date flake is pre-existing, unrelated)
```

## Follow-ups

- If Robinhood ever adds `agentic_allowed` to the `get_accounts` response, the
  explicit field will correctly override the default via `??`.
- No migration needed — this is a runtime derivation, not persisted state.
