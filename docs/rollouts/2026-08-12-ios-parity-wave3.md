# 2026-08-12 — iOS parity wave 3: order cancel from the phone

Branch `monet/ios-order-cancel` · worktree `~/apps/trading-monet-wave3`.

## 1. Context & Objective

Open orders were the phone's last see-but-cannot-act money surface: the Assets screen listed
working broker orders and offered nothing to do about them, so killing a rotting limit order
meant finding a laptop.  This wave closes that loop by building the iOS half of roadmap item #3
on top of the server command that was landed separately.

This branch is an **integration branch**.  It merges, unchanged, two branches that were built in
parallel and verified independently, then adds the iOS UI that needs both:

| Merged branch | What it brought | Its own rollout note |
| --- | --- | --- |
| `monet/ios-parity-wave2` (`ff6b7756`) | Tighten Guardrails, `snapshot.catalog` decoding + `MobileStore.serverAdvertises`, universal links / deep-link routing | `docs/rollouts/2026-08-12-ios-parity-wave2.md` |
| `monet/order-cancel-server` (`4f9d3aac`) | `order.cancel` mobile command, `src/lib/order-cancel.ts` (`cancelWorkingOrder`) shared with the console route | `docs/rollouts/2026-08-12-order-cancel-command.md` |

Both merged clean — no conflicts, no manual resolution, no regeneration of the Xcode project
was needed for the merge itself (the two branches touched disjoint files apart from `STATUS.md`
and `docs/EFFORT-LOG.md`, which auto-merged).

## 2. Changes Made

### The cancellable predicate is the whole safety property

`OrderCancellation.isWorkingState` is an exact mirror of the server's `isWorkingOrderState`
(`src/lib/broker-held-orders.ts`) — `ACTIVE_BROKER_ORDER_STATES` plus
`EXTRA_WORKING_ORDER_STATES`.  That predicate is not a UI nicety: it is the same precondition
`cancelWorkingOrder` enforces for this lane (`requireWorkingOrder: true`), so the control appears
exactly where the server would accept it.

- Cancellable: `accepted`, `accepted_for_bidding`, `confirmed`, `held`, `new`, `open`,
  `partially_filled`, `pending`, `pending_cancel`, `pending_new`, `pending_replace`, `queued`,
  `submitted`, `suspended`, `unconfirmed`, `stopped`, `calculated`.
- Not cancellable: everything else, including **`done_for_day`** — a terminal day-order outcome
  Alpaca returns forever in history, deliberately excluded from the server's working set (the
  same trap that once made the web Orders screen show hundreds of finished orders as pending).
- Matching is trimmed + lowercased; an unrecognised broker word is treated as un-cancellable
  rather than offered on a guess.
- `pending_cancel` stays cancellable on purpose, matching the console: a broker cancel stuck in
  that state is a reason to ask again, not a reason to remove the lever.

`/api/mobile/snapshot` already filters `orders` through the same predicate, so on a current
server every listed row passes.  The client-side check is still real work: the app renders
snapshots restored from its own `UserDefaults` cache, which can predate that filter.

### The control

`ios/SocraticTrade/MarketsView.swift` — `OrderRow` gained a trailing **Cancel Order** button
(44 pt minimum height, `.bordered`, destructive role) shown only when the row is cancellable
**and** the deployment advertises `order.cancel` (`store.serverAdvertises`, from wave 2's
catalog).  Submission goes through the ordinary `store.submit` path, so it inherits the busy
guard, the per-operation idempotency key, and the snapshot reload — no new store surface.

- **Payload**: `{ orderId, accountNumber }`, where `accountNumber` is
  `snapshot.readiness.selectedAccountNumber` (server-side that is `policy.accountNumber`, the
  exact value `cancelWorkingOrder` compares against).  This is the server's stale-view guard: a
  cancel queued while looking at account A is refused rather than landing on account B.  The key
  is omitted, not blanked, when no account is selected — the phone never claims a guard it did
  not assert.
- **Operation id** is `order.cancel:<orderId>`, so a double tap re-uses the first attempt's
  idempotency key instead of asking the broker twice, and one order's in-flight cancel never
  disables another row's button.
- **Swipe**: the same `swipeRevealAction` used by swipe-to-reject on proposals and
  swipe-to-delete on alerts, opening the *same* confirmation dialog rather than firing directly.
- **Outcome** surfaces the way every other row command's does: the in-button spinner while
  `store.isBusy`, then either the row disappearing on the reload (a cancelled order is no longer
  working, so the server drops it from `orders`) or the store's own failure banner carrying the
  server's message verbatim.
- `AppFormat.commandLabel` learned `order.cancel` -> "Cancel Order" so Activity and the
  unavailable-command message read as words.

### Ceremony

A confirmation dialog, and nothing more — the same weight the alert-delete row already carries.
No typed confirmation: the server requires none for cancel even on a live brokerage account,
because cancelling prevents an execution rather than causing one.  The dialog copy is condensed
from the console's cancel sheet and every clause is load-bearing — no new order is placed, fills
that already happened stand, and the cancel is a request the broker may take a moment to honour.

Buttons are **Cancel Order** (destructive) and **Keep It Working** — "Cancel" alone would be
ambiguous next to the thing being cancelled.

### Files

New:
- `ios/SocraticTrade/OrderCancel.swift`
- `ios/SocraticTradeTests/OrderCancelTests.swift`
- `docs/rollouts/2026-08-12-ios-parity-wave3.md` (this note)

Modified:
- `ios/SocraticTrade/MarketsView.swift`
- `ios/SocraticTrade/AppComponents.swift` (one command label)
- `ios/Socratic Trade.xcodeproj/project.pbxproj` (regenerated for the two new files)
- `STATUS.md`, `docs/EFFORT-LOG.md`

No web/server file was changed by this wave; the server half arrived via the merge.

## 3. Decisions & Trade-offs

- **`store.canSubmit` gating left as-is.** `order.cancel` is not added to `MobileStore`'s
  `protectiveCommands` set, so it is catalog-gated (an older server genuinely cannot run it —
  better to hide the control than to collect a 400) and snapshot-staleness-gated like every
  other row action.  The rows themselves come from that snapshot, so acting on data the app
  cannot vouch for would be the incoherent option; pull-to-refresh is one gesture away.  This is
  deliberately not new friction — it is the same gate `alert.delete` and `watchlist.remove`
  already sit behind.
- **Predicate duplicated rather than inferred.** A "not obviously terminal" heuristic would have
  been shorter and would have quietly offered Cancel on `done_for_day`.  The literal set is
  annotated with its source of truth so the next drift is a visible diff.
- **No replace-at-market.** Out of scope, and the server half explicitly did not build it; the
  requirements are listed in `docs/rollouts/2026-08-12-order-cancel-command.md` §5.
- **No dust-warning surface on the phone.** The server returns `dustWarning` on the cancel
  result and the console keeps its sheet open to show it, but the mobile command result is not
  currently threaded into a per-row view model.  The advisory never gates the cancel, and the
  server still raises its own `risk_advisory` notification, so nothing is lost silently —
  rendering it on the card is a follow-up, listed below.

## 4. Verification State

All foreground, full output observed.

```
cd ios && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild \
  -project "Socratic Trade.xcodeproj" -scheme SocraticTrade \
  -destination 'platform=macOS,variant=Designed for iPad' test
```
-> `Executed 64 tests, with 0 failures (0 unexpected)` / `** TEST SUCCEEDED **`
(56 inherited from the merged wave-2 branch, +8 new in `OrderCancelTests`).

```
npx tsc --noEmit          # clean, no output
npm run lint              # 750 warnings, 0 errors (grandfathered backlog)
npx vitest run test/mobile-order-cancel.test.ts \
  test/apple-app-site-association-route.test.ts test/mobile-api.test.ts \
  test/orders-cancel-dust-risk-route.test.ts test/dashboard-feed.test.ts
                          # Test Files 5 passed (5) · Tests 59 passed (59)
```

`xcodegen generate` was run for the two new `.swift` files and the `objectVersion = 100` /
`preferredProjectObjectVersion = 100` header pair re-applied (both the top-level key and the
inner `PBXProject` value).  `Info.plist` untouched — `project.yml` still declares the version
keys as build-variable substitutions, so the regen did not reintroduce the literal `1.0`/`1`
regression.  The resulting pbxproj diff is 8 lines, all of them the two new file entries.

## 5. Next Steps & Blockers

- No credential or infrastructure action was needed or taken.  Shipping this to a device is the
  ordinary TestFlight path (`scripts/ios-ship-testflight.sh`), which is an owner action.
- Follow-up (small): render the server's `dustWarning` on the order card after a successful
  cancel, matching the console sheet's behaviour of staying open to show it.
- Follow-up (larger): replace-at-market from the phone — requirements enumerated in the
  order-cancel server rollout note.
