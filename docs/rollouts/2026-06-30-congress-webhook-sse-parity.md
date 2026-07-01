# 2026-06-30 — Congress event ingest: App A wire-shape parity

## Summary

Made App B's congress-event ingestion tolerant of every shape App A
(congress.trade) actually sends on both the webhook and SSE channels, fixing a
silent trade-drop. `applyCongressEvent` previously accepted only the canonical
`{ type: "congress.trade", data: { trades: [...] } }` envelope.

## Why

Cross-app review of the Congress.Trade ↔ Agentic Trading contract found the
real-time channel was dropping trades end-to-end:

- **Webhook:** App A posts `{ event: "trade.new", transaction: <tx> }`
  (`src/delivery/webhook.ts`). App B read `.type` / `.data.trades`, so the body
  failed as `invalid-event` → HTTP 400 → App A retried then dead-lettered. The
  webhook has never delivered a trade.
- **SSE:** App A emitted `event: trade.new` (now `congress.trade`), and the
  stream client overlays the event name onto `env.type` while the `data:` line
  is the payload — so trades arrive at the top level (`env.trades`), not under
  `env.data.trades`. Both the old `trade.new` name and the flattened shape were
  dropped as `unknown-type` / `no-trades`.

The canonical event type is `congress.trade` per
`@jaywedgeworth22/congress-trading-shared` (`CONGRESS_EVENT_TYPES`). Rather than
depend on App A shipping a matching change first, App B now accepts all shapes
(Postel's law) so it works across the rollout window in either direction.

## What changed

`src/lib/congress-trade-events.ts` — `applyCongressEvent`:
- Resolve the event type from `type` **or** the legacy `event` field; treat
  `trade.new` as an alias of `congress.trade`.
- Collect trade rows from `data.trades`, top-level `trades`, `transaction` /
  `data.transaction`, and (last resort) the envelope itself, then coerce+dedupe
  as before. Idempotency, validation, and the insider/ref/price/spx branches are
  unchanged.

`test/congress-webhook-parity.test.ts` — new regression suite covering the
webhook shape, the `trade.new` alias, the flattened SSE frame, the canonical
envelope, and the typeless-reject case.

## Cross-app note

The counterpart App A change (emit the canonical `congress.trade` on SSE) is in
Congress.Trade PR #123; App A's **webhook** (`webhook.ts`) still emits
`event: "trade.new"` and would benefit from the same alignment, but this change
makes App B robust regardless.

## Verification (run in the worktree)

- `npx vitest run test/congress-trade-events.test.ts test/congress-webhook-parity.test.ts test/congress-stream.test.ts` → 30 passed
- `npx eslint src/lib/congress-trade-events.ts test/congress-webhook-parity.test.ts` → clean
- `npx tsc --noEmit` → clean

## Next

- Align App A's webhook to emit `congress.trade` (Congress.Trade side).
- Consider hoisting a shared "coerce trades from any envelope" helper into
  `congress-trading-shared` so both apps share one tolerant reader.
