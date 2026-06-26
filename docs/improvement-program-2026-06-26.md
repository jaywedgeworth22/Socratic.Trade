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
| 10/#2 | **risk-breaker + short/cover P&L + notional tests** | ready | **risk-breaker.test.ts DONE (13 tests)**; short/cover P&L + daily-notional tests PENDING | `test/risk-breaker.test.ts` ✅, `test/performance.test.ts`, `test/daily-notional-reset.test.ts` |
| 6+7 | **Langfuse offline eval/regression + 6-provider answer-quality suite** | ready | TODO | `scripts/eval/*` (dataset, scoring, run-offline, run-providers), `test/eval-offline.test.ts` |
| 1+#6 | **Wire RAG metadata filters + minScore floor** | ready | TODO (next) | `vector-db.ts` (new `defaultMinScore()`), `strategy.ts:~299`, `chat/orchestrator.ts:~171`, `.env.example` |
| 4 | **Hybrid dense+sparse/BM25 retrieval** | ready | TODO (after wire-filters; shares vector-db.ts) | `vector-db.ts`, `app/api/admin/reindex-hybrid/route.ts`, `.env.example` |
| 3 | **Embed congressional + insider disclosures into vector store** | ready | TODO | new `web-sources/disclosure-rag.ts`, `web-sources/index.ts`, `sec-filings.ts`, `.env.example` |
| 8 | **Reasoning/template-collapse diversity check on rationales** | ready | TODO (shares strategy.ts/types.ts) | new `rationale-diversity.ts`, `db-proposals.ts`, `strategy.ts`, `types.ts` |
| 5 | **Market-data staleness gate** | ready | TODO (shares strategy.ts/types.ts) | `types.ts`, `policy.ts`, `defaults.ts`, `strategy.ts`, `market.ts`, `app/api/policy/route.ts` |
| 2 | **Query expansion / multi-query / RRF (RAG-Fusion)** | **PENDING (opus re-run wf_078f533f-979)** | TODO | retrieval path in `vector-db.ts` + `strategy.ts` |
| 7/#4 | **Coarse credit assignment + attribution** | **PENDING (opus re-run)** | TODO | `strategy-tuning.ts`, `performance.ts` |
| 3/#3 | **Durable/locked autonomy scheduler** | **PENDING (opus re-run)** | TODO | `scheduler.ts` + a SQLite lease/lock |
| 5 | **Reconsider Self-RAG / HyDE / sentence-window / contextual compression** | **PENDING (opus decision re-run)** | DECIDE (likely mostly "skip" — reranker already present) | n/a |
| 9 | **karpathy/autoresearch review** | research | the planner agent MISREAD this as an "autonomous tuning loop" feature — IGNORE that; treat as a research read only (retry pending) | n/a |

## Key spec notes (the ready ones)
- **rag-wire-filters (S, no flag):** `buildExtraFilters` + `minScore` are built in `vector-db.ts` but every
  caller passes `undefined`. Add `defaultMinScore()` (env `VECTOR_MIN_SCORE`, default 0.30); thread
  `{docType, minScore}` at `strategy.ts` per-symbol call + forward `args.doc_type`/`minScore` in
  `chat/orchestrator.ts` (it already extracts doc_type then drops it). Advisory path only (not money-path).
- **risk-tests (M, no flag):** risk-breaker.test.ts ✅ done. Remaining: short/cover realized-P&L across all
  four `OrderSide`s in `performance.test.ts`, and daily-notional accounting/reset in a new test (the
  CLAUDE.md "verify all four sides explicitly" gap).
- **staleness-gate (M, flag):** add a per-data-class max-staleness threshold + a policy setting; enforce at
  proposal review so the strategy can't act on stale-but-cached data (today freshness is only a label).
- **langfuse-evals (M):** Langfuse already a dep; seed dataset + offline runner replaying across the 6
  providers + deterministic & LLM-judge scoring → catches prompt/RAG/provider regressions.
- **rag-embed-congress-insider (M, flag):** vectorize congress/insider (currently structured-only) so
  "congressional-context retrieval" is real RAG; reuse `rag/chunk.ts` + the SEC ingestion pattern.
- **rag-hybrid-bm25 (M, flag):** Pinecone sparse-dense; needs a reindex (admin route). Land after wire-filters.
- **reasoning-diversity (M, flag):** similarity metric over proposal rationales to flag boilerplate/
  input-agnostic output across a run.

(The 4 PENDING opus specs will be appended here when the re-run lands.)

## Verification
- risk-breaker.test.ts: 13 tests pass; full trio via land.sh.
