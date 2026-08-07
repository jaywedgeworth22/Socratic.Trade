# 2026-08-07 — iOS UI title-case headings / sentence-case values

## Owner copy rules
- **Headings, titles, buttons**: Title Case (Agent Controls, Run Once, Win Rate, Needs Attention, Review N Proposals, Current Policy, Connected Accounts, User Info, Delete Account, Last Run).
- **Values / answers**: sentence or lower case (not reported, ask-first, intraday, not scheduled, every 60 min, open holdings, account return minus…).
- **No "Live" callouts** on accounts (all accounts are real money); paper only as `Broker (paper)`.
- Drop redundant **Paper account** under Open P&L (PAPER pill + account name already enough).
- Positions tile: large count with **open holdings** trailing on the same row.

## Files
- `ios/SocraticTrade/AppComponents.swift` — format helpers + MetricTile trailing detail
- `ios/SocraticTrade/HomeView.swift` — Home / settings copy
- `ios/SocraticTrade/InsightsView.swift`, `ActivityView.swift` — Run Once / Last Run
