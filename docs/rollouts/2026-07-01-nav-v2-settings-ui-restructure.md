# 2026-07-01 — NAV_V2 physical UI restructure (#3/#4/#5-physical)

Branch: `claude/nav-v2-settings-ui-restructure` (based on `main`, disjoint from the #7/#8 real-money gate in
PR #310). Owner chose **"full physical UI restructure now"** for the parts of delivery-plan PRs #3–#5 that the
earlier flag-gated batch (PR #305) deferred to the shell. **Everything is behind `NAV_V2`; flag-off is
byte-identical.** **Requires preview-QA (flip `NAV_V2`) — this is UI I can't browser-test in the cloud env.**

## #3-physical — settings modal → scope-first 8-node Scope-B tree

### Summary
Rebuilt the off-rail user Settings into the eight scope-first nodes, **additively**: the new tree renders only
when `NAV_V2` is on; the flag-off modal is untouched (every existing block keeps its `!navV2 ||` escape).

- New module-level `UserNode` union + `USER_NODE_TABS` (in `dashboard-client.tsx`): **Account & Security ·
  Connections · Keys & Models · Alert delivery · Data & Privacy · Presets · Appearance · Admin**.
- Under `NAV_V2` + user tier, the settings tabs render the 8 nodes (Admin only when
  `currentUser.isAdmin`). Four nodes **reuse existing content** by mapping to the current `section`
  (Keys & Models→the API-keys section, Appearance→display, Alert delivery→notifications,
  Data & Privacy→data) — no duplication, no extraction. Four are **new panels**:
  - **Account & Security** — identity line + the **relocated** `AccountDeletionPanel` (moved out of Data &
    Privacy under the flag).
  - **Connections** — broker-link pointer (`Open Accounts ›`), noting keys live under Keys & Models.
  - **Presets** — library pointer (apply happens in Strategy).
  - **Admin** — role-gated (`isAdmin`) operator pointer to `/admin`.
- Each existing user block now guards `section === X && (!navV2 || userNode === "<node>")`, so under the flag
  exactly one node renders (no double-render); flag-off is `!navV2` → unchanged.

### Deferred within #3-physical (next slices)
- Guardrails (risk section) **Essentials→Advanced** live reveal.
- Lifting the Presets **CRUD** UI out of `StrategyView` into the Presets node (pointer for now).
- Keys & Models **default-model** controls beyond the current API-keys panel.

### Verification
`tsc` clean · `lint` 0 errors · `npm test` 205 files / 2069 tests · `build` success. Flag-off byte-identical
(the current 4-tab user modal + 5-tab account modal render exactly as before when `NAV_V2` is off).

## #4-physical / #5-physical — pending
_pending_
