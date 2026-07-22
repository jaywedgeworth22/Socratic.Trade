# Socratic usage telemetry v2 producer

## Contract

- Exact shared dependency: immutable `v2.0.0`, resolved over HTTPS to
  `19a077a4a8245963775c9fedb462a6741b0a70aa`.
- Wire envelope: `schemaVersion: 2`, `producerId: "socratic-trade"`, and up to 100 strict v2 events.
- Event identity: required `eventId`; durable source-row and aggregate-window identities remain
  stable across ambiguous retries.
- Credential attribution: legacy `keyRef` maps to `producerKeyRef`; producer identity is never
  duplicated inside events.
- ACKs and errors are parsed through the shared v2 schemas, including retryability metadata.

## Backlog safety

Durable LLM, RAG, and provider-dispatch rows are reconstructed from source rows. A process-local
version bump normalizes any pre-v2 HMR buffer once (`sourceApp` removed, `idempotencyKey` to
`eventId`, `keyRef` to `producerKeyRef`) before validation and retry.

Existing replay cursors were ACKed under v1's explicit persistence key, while live pushes did not
advance those cursors. Before switching a ledger to strict-v2 identities, replay freezes a durable
high-water mark, persists it before network I/O, and drains that fixed bounded window through the
actual accepted v1 envelope, preserving
the receiver's old explicit `idempotencyKey`. The shared `sendLegacyOutbox` adapter is intentionally
not used here because it promotes the old key to a v2 `eventId`, which derives a new receiver identity.
Replay also persists whether the legacy overlap row has already been acknowledged so a later bounded
page is exclusive; a crash before the watermark/overlap transaction remains safe to retry inclusively.
After the bounded window is acknowledged, replay records `legacy-drained`; its boundary remains
exclusive until a later strict-v2 row is acknowledged and advances the marker to `v2-active`.
Rows created after the snapshot therefore use strict-v2 identities without double-counting the
migration boundary, while normal inclusive overlap remains crash-safe once v2 is active.

## Verification

- Cold tokenless install: `GIT_SSH_COMMAND=false npm ci` under Node 24; shared version 2 and v2
  exports loaded.
- TypeScript: `npx tsc --noEmit`.
- Scoped lint: producer plus both telemetry test suites.
- Focused Vitest: 7 files / 83 tests covering push, replay, ledger durability, dispatch cost,
  budgets, v2 envelopes, typed ACKs, ambiguous retry, and legacy HMR normalization.
- Full Vitest exercised 424 files / 4,952 tests; 4,951 passed and the only failure was the old v1
  `sourceApp` assertion updated during that run. The final affected producer/replay/FMP regression
  set passed 3 files / 46 tests after the update.
- Production build: `npm run build` under Node 24.
- Cutover regression: `npx vitest run --maxWorkers=1 test/usage-monitor-replay.test.ts` — 12/12
  tests passed after rebuilding `better-sqlite3` for the active Node ABI; the suite covers the
  actual-v1 bounded catch-up, a fixed boundary across page-limited passes, fail-closed corrupt-state
  recovery, boundary exclusion, and transition to post-cutover strict-v2 overlap.
- Review follow-up regression: `npx vitest run --maxWorkers=1 test/usage-monitor-replay.test.ts test/usage-monitor-push.test.ts` — 37/37 tests passed.

## Promotion gate

The receiver gate cleared on exact Usage-Monitor main
`335723775ef0f8114ee1ca77b4716139018026dc`, committed live on Oracle with strict readiness,
fresh scheduler, Garage restore/integrity/FK/schema verification, and a committed deploy receipt.
Land through protected checks, then verify the exact Coolify production SHA plus one authenticated
v2 ACK.
