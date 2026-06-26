# Improvement program — RAG / learning-loop / risk / observability (2026-06-26)

Owner-approved batch of 14 items (some overlap → 11 distinct workstreams). Planned by a model-tiered
fan-out (workflow `wf_078f533f-979`); sequenced to minimize file conflicts. **Autonomy is now treated as
potentially live**, so risk/correctness items are production-grade. This doc is the handoff source of truth —
another platform (Codex/Antigravity) or a fresh session can pick up any item from its spec + status.

## How to work this program
- **One PR per item** (or per safe batch). Land via `scripts/land.sh` (tsc → test → build). Money-path /
  risk items get an adversarial review pass before merge.
- **File-overlap is the constraint.** The RAG-retrieval items all rewrite the same regions of
  `vector-db.ts`; `strategy.ts` and `types.ts` are touched by several items; `db.ts migrate()` is the
  documented merge-conflict trap. Do NOT parallelize items that share a hot file — follow the order below.
- Keep changes **additive + flag-gated** where they alter money-path behavior; never flip `paperMode`.

## Sequenced order (from the opus sequencer)
1. **risk-tests** (tests-only, parallel-safe) — Batch 1
2. **langfuse-evals** (new files, parallel-safe) — Batch 1
3. **rag-wire-filters** (vector-db base layer; land before hybrid) — Batch 2
4. **rag-hybrid-bm25** + **rag-embed-congress-insider** (review) — Batch 3
5. **learning-reasoning-diversity** + **staleness-gate** (strictly sequential; both touch strategy.ts/types.ts) — Batch 4
6. **rag-multiquery-rrf**, **learning-coarse-credit**, **scheduler-durable** (opus designs) — after their specs land
7. **rag-selfrag-hyde-decision** (decision, may be mostly "skip")

## Item status
| # | Item | Spec | Status | Files (primary) |
|---|---|---|---|---|
| 10/#2 | **risk-breaker + short/cover P&L + notional tests** | ready | **DONE** — risk-breaker (13) ✅; calculatePnl four-side realized-P&L + notional cross-boundary (8 added) ✅. No production bugs found (adversarially verified). | `test/risk-breaker.test.ts` ✅, `test/performance.test.ts` ✅, `test/daily-notional-reset.test.ts` ✅ |
| 6+7 | **Langfuse offline eval/regression + 6-provider answer-quality suite** | ready | TODO | `scripts/eval/*` (dataset, scoring, run-offline, run-providers), `test/eval-offline.test.ts` |
| 1+#6 | **Wire RAG metadata filters + minScore floor** | ready | **DONE** (PR after #186) — `defaultMinScore()` (env `VECTOR_MIN_SCORE`=0.30) wired into strategy + chat retrieval; **buildExtraFilters made CASING-TOLERANT** (stored doc_type is inconsistent: sec-filings "10-K" vs sec8k "8-k" — a single-casing filter would have silently excluded 10-K/10-Q; fixed) | `vector-db.ts`, `strategy.ts`, `chat/orchestrator.ts`, `.env.example`, `test/vector-db-retrieval.test.ts` |
| 4 | **Hybrid dense+sparse/BM25 retrieval** | ready | TODO (after wire-filters; shares vector-db.ts) | `vector-db.ts`, `app/api/admin/reindex-hybrid/route.ts`, `.env.example` |
| 3 | **Embed congressional + insider disclosures into vector store** | ready | TODO | new `web-sources/disclosure-rag.ts`, `web-sources/index.ts`, `sec-filings.ts`, `.env.example` |
| 8 | **Reasoning/template-collapse diversity check on rationales** | ready | TODO (shares strategy.ts/types.ts) | new `rationale-diversity.ts`, `db-proposals.ts`, `strategy.ts`, `types.ts` |
| 5 | **Market-data staleness gate** | ready | TODO (shares strategy.ts/types.ts) | `types.ts`, `policy.ts`, `defaults.ts`, `strategy.ts`, `market.ts`, `app/api/policy/route.ts` |
| 2 | **Query expansion / multi-query / RRF (RAG-Fusion)** | ready (opus) | TODO — see "Opus specs" below | retrieval path in `vector-db.ts` + `strategy.ts`, `test/vector-db-fusion.test.ts` |
| 7/#4 | **Coarse credit assignment + attribution** | ready (opus) | TODO — see "Opus specs" below | `performance.ts`, `types.ts`, `strategy-tuning.ts`, `strategy.ts`, `backtest.ts`, `db-fills.ts` |
| 3/#3 | **Durable/locked autonomy scheduler** | ready (opus) | TODO — see "Opus specs" below | new `scheduler-lease.ts`, `scheduler.ts`, `health`/`ready` routes |
| 5 | **Reconsider Self-RAG / HyDE / sentence-window / contextual compression** | ready (opus) | **DECISION: SKIP all four now** — see "Opus specs" below | n/a |
| 9 | **karpathy/autoresearch review** | research | the planner agent MISREAD this as an "autonomous tuning loop" feature — IGNORE that; treat as a research read only (retry pending) | n/a |

## Key spec notes (the ready ones)
- **rag-wire-filters (S, no flag) — DONE:** `buildExtraFilters` + `minScore` were built but every caller
  passed `undefined`. Added `defaultMinScore()` (env `VECTOR_MIN_SCORE`, default 0.30, clamped [0,1]); wired
  `{docType, minScore}` into the `strategy.ts` per-symbol call and forwarded `args.doc_type`/`minScore` in
  `chat/orchestrator.ts`. **Deviation from spec:** the spec's single-casing docType list would have silently
  excluded all uppercase-stored 10-K/10-Q chunks (sec-filings writes "10-K", sec8k writes "8-k", Pinecone
  `$in` is exact-match). Made `buildExtraFilters` casing-tolerant (each type → original+lower+upper, deduped).
  Advisory path only; no flag.
- **risk-tests (M, no flag) — DONE:** risk-breaker.test.ts ✅ (PR #186). `calculatePnl` four-side realized-P&L
  + the notional cross-boundary case ✅ (this PR). **Stale-plan correction:** daily-notional *accounting/reset*
  was NOT a gap — `daily-notional-reset.test.ts` already covered buy/short-counted vs sell/cover-exempt,
  tenant isolation, fallback, and the NY-midnight boundary math (T6/T13). The genuine `calculatePnl` gap was
  the realized-P&L side coverage (only long-FIFO + basic short/cover existed); added short returnPct/side,
  partial cover, partial-then-full sell, the all-four-side interleave (the critical FIFO/sign case), both
  flat-close mirrors, and a mixed residual long+short mark-to-market. The only notional addition was a
  cross-boundary (orders-age-out) case. All values adversarially re-derived from first principles; no
  production bug found (the CLAUDE.md "verify all four sides explicitly" code is correct).
- **staleness-gate (M, flag):** add a per-data-class max-staleness threshold + a policy setting; enforce at
  proposal review so the strategy can't act on stale-but-cached data (today freshness is only a label).
- **langfuse-evals (M):** Langfuse already a dep; seed dataset + offline runner replaying across the 6
  providers + deterministic & LLM-judge scoring → catches prompt/RAG/provider regressions.
- **rag-embed-congress-insider (M, flag):** vectorize congress/insider (currently structured-only) so
  "congressional-context retrieval" is real RAG; reuse `rag/chunk.ts` + the SEC ingestion pattern.
- **rag-hybrid-bm25 (M, flag):** Pinecone sparse-dense; needs a reindex (admin route). Land after wire-filters.
- **reasoning-diversity (M, flag):** similarity metric over proposal rationales to flag boilerplate/
  input-agnostic output across a run.

## Opus specs (the 4 hardest designs — recovered from the re-run)
- **rag-multiquery-rrf (M, flag) — DO IT, two stages.** Stage 1: template-mode multi-query + Reciprocal Rank
  Fusion *before* the cross-encoder rerank, flag-gated OFF. The single embed call already takes an array
  (`vector-db.ts:558` `embedWithRetry(voyage, [query], ...)`), so batching N query variants needs no SDK
  change and keeps embed cost ~flat; the expensive rerank stage is unchanged (RRF only widens recall, rerank
  still does final precision against the true query). Stage 2 (later opt-in): LLM-generated query variants.
  New `test/vector-db-fusion.test.ts`. NOTE: shares `vector-db.ts` retrieval region with rag-wire-filters +
  rag-hybrid-bm25 → land sequentially after both.
- **learning-coarse-credit (L, flag) — DO 3 additive changes, in order.** (B) plumb `ClosedLot.mae/mfe`
  (read-only prereq). (A) **the real "coarse" miss:** attribution currently credits 100% of realized P&L to
  the EXIT run (`performance.ts:414` `addAttribution` keys by the closing `fill.runId`), so the run whose
  ENTRY decision generated the edge gets 0. Fix = add dual-sided/decision-run attribution as NEW optional
  fields (don't redefine `RunAttribution.realizedPnl` — too many silent consumers). Highest-value, lowest-risk
  (purely additive, no money path). (C) withhold weight changes the OOS gate couldn't validate. **Defaults:**
  B's MAE/MFE-weighted credit OFF (changes sizing math → opt-in); C ON (only makes the advisory tuner more
  conservative).
- **scheduler-durable (M, flag) — DO a CAS lease.** New `scheduler-lease.ts` with a single-statement
  compare-and-swap lease stored in the existing `settings` table (NO migration — mirrors the proven
  `acquireStrategyLock` pattern). Gate the whole `tick()` body behind `SCHEDULER_SINGLE_LEADER` (default OFF);
  register SIGTERM/SIGINT/beforeExit release; surface lease owner+age on `/health` + `/ready`. **The real
  gap:** `runStrategyOnce` already holds a cross-process lock, but the synthetic-stop monitor in the tick body
  (`scheduler.ts:~200`) can place broker exit orders and is only in-process guarded → two processes double-fire.
  SKIP (separate PRs): the `acquireStrategyLock` TOCTOU rewrite (money-path) and a durable external scheduler.
- **rag-selfrag-hyde-decision (S) — DECISION: SKIP all four now.** The recall gap HyDE/Self-RAG/sentence-
  window/contextual-compression address is already covered by domain-tuned `voyage-finance-2` embeddings + the
  hard symbol metadata filter (`vector-db.ts:572`) + the cross-encoder reranker + over-fetch. Strategy queries
  are already elaborated pseudo-documents (`strategy.ts:299`); HyDE would add an LLM round-trip per symbol for
  near-zero embedding-space movement on a latency-sensitive chat path + a deterministic money path. Revisit
  ONLY if relevance-floor telemetry shows the candidate pool is frequently empty/weak for legitimate queries
  (a measured problem, not a speculative one). No code now.

## Verification
- risk-breaker.test.ts: 13 tests pass (PR #186).
- rag-wire-filters: `tsc --noEmit` clean; `vector-db-retrieval` + `chat-orchestrator` tests pass (21); full
  trio via land.sh.
