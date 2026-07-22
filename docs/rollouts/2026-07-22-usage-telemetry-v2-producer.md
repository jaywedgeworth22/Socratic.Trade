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

Durable LLM, RAG, and provider-dispatch rows are not serialized v1 envelopes. Replay reconstructs
them from source rows, so it now produces strict-v2 payloads directly. A process-local version bump
normalizes any pre-v2 HMR buffer once (`sourceApp` removed, `idempotencyKey` to `eventId`, `keyRef`
to `producerKeyRef`) before validation and retry. There is no dual-write path.

Existing replay cursors were ACKed under v1's explicit persistence key. A durable per-ledger cutover
marker therefore keeps the first v2 pass strict (`>` the v1 cursor), preventing the old boundary row
from being inserted again under v2's derived `(producerId,eventId)` key. The marker is written in the
same transaction that advances the first v2-ACKed cursor; inclusive crash-safe overlap resumes only
after that point.

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
- Cutover regression: push + durable replay suites passed 2 files / 35 tests under Node 24,
  including a seeded v1 watermark that sends only the following v2 row before overlap resumes.

## Promotion gate

The receiver gate cleared on exact Usage-Monitor main
`335723775ef0f8114ee1ca77b4716139018026dc`, committed live on Oracle with strict readiness,
fresh scheduler, Garage restore/integrity/FK/schema verification, and a committed deploy receipt.
Land through protected checks, then verify the exact Coolify production SHA plus one authenticated
v2 ACK.
