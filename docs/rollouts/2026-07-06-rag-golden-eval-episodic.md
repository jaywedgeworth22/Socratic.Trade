# 2026-07-06 - rag-golden-eval-episodic

## Summary

- Expanded the RAG retrieval golden eval with 10 new episodic-decision-memory fixture cases
  (`socratic-decision`/`coach-note`/`lesson` doc types) plus two new `describe` blocks in the eval
  test file: an episodic recall@k/MRR suite, and a single-query-vs-multi-query suite exercising
  `RetrieveOptions.queries`/`rrfFuse` (#822) directly against `retrieveContextDetailed`.
- Test/fixture/docs only. No production code changed. No RAG env flag default changed
  (`RAG_MULTIQUERY`/`RAG_HYDE` remain default-off, untouched).

## Why

- Triage-verified ground truth going in: `test/fixtures/rag-retrieval-eval-fixture.ts` (462 lines
  before this change) had ONLY filings doc-type cases (`10-k`/`10-q`/`8-k`) and zero cases over
  `EPISODIC_DOC_TYPES = ["socratic-decision", "coach-note", "lesson"]`
  (`src/lib/experience-memory.ts:44`) — the episodic decision-memory retrieval pass
  (`retrieveDecisionExperiences`, wired into `strategy.ts` per the 2026-07-04 composite review) had
  no eval coverage at all, and the existing filings-only harness reportedly saturates at recall 1.0
  because none of its hard negatives are genuinely confusable near-misses for a decision-memory
  query.
- `#822` (HyDE + evidence-derived multi-query retrieval, merged 2026-07-05,
  `d97b7c71`) added `RetrieveOptions.queries` + `rrfFuse` fan-out to `retrieveContextDetailed`, but
  `test/rag-retrieval-eval.test.ts`'s `runFixture` never passed `options.queries` — so the eval
  harness had no coverage of the multi-query path even though it exists in production (behind
  default-off flags in `strategy.ts`).
- Both gaps are closed here without touching production code: the fixture gained realistic
  episodic cases (mirroring `buildClosedLotExperienceDocument`'s exact text shape:
  `ticker`/`side`/`thesis_tag`/`entry_market_regime`/`entry_rationale`/`exit_reason`/
  `realized_outcome`) with hard negatives that share symbol+regime but flip thesis or direction —
  the same kind of near-miss a real cross-encoder must resolve, not a bag-of-words giveaway — and
  the test file gained a small, additive `cases` option on `runFixture` plus a dedicated
  single-vs-multi-query harness function that calls `retrieveContextDetailed` with and without
  `options.queries` set.

## Files

- `test/fixtures/rag-retrieval-eval-fixture.ts` — added 10 new cases (fixture now 39 cases total,
  29 filings + 10 episodic): `episodic-nvda-momentum-analog`, `episodic-tsla-riskoff-counterexample`,
  `episodic-owner-coaching-sizing`, `episodic-lesson-sector-concentration`,
  `episodic-msft-value-thesis-analog`, `episodic-amzn-thesis-tag-exact-term`,
  `episodic-asof-guard-analog`, `episodic-googl-counterexample-dissent`,
  `episodic-meta-side-short-analog`, `episodic-jpm-rate-thesis-analog`. Every case has >=1 hard
  negative disjoint from gold and every chunk carries `acceptance_datetime` (required by the
  existing golden-set lint in `rag-retrieval-eval.test.ts`, which still passes unmodified over the
  expanded fixture).
- `test/rag-retrieval-eval.test.ts` —
  - `runFixture` gained an additive `cases?: FixtureCase[]` option (defaults to `RAG_EVAL_FIXTURE`,
    so every pre-existing call site is byte-for-byte unchanged).
  - New `describe("episodic decision-memory eval ...")` block: golden-set-size/hard-negative lint
    over the episodic subset, a recall@3/MRR floor check (looser than the filings baseline by
    design — see inline comment on why), a hard-negative-lint check, and an as-of guard check for
    the new `episodic-asof-guard-analog` case.
  - New `describe("item #822: single-query vs multi-query ...")` block with a dedicated
    `runSingleVsMultiQuery` harness (mirrors `runFixture`'s mock setup but issues N `mocks.query`
    mock responses, one per fan-out variant, then calls `retrieveContextDetailed` once with
    `options.queries` unset and once with it set). Three `it`s: no-regression on the near-miss
    episodic case, no-regression on the exact-term case, and a plumbing check (a synthetic 3-chunk
    fixture case) asserting `mocks.query` is called once per fan-out variant and the fused pool is
    the de-duplicated union across variants — proof the fan-out/`rrfFuse` path actually ran, not a
    single-query short-circuit.
- `STATUS.md` — prepended a 2026-07-06 section.
- `docs/EFFORT-LOG.md` — added one row under "In Progress" for this lane.

## Verification

- `npx tsc --noEmit` — clean, no errors.
- `npx vitest run test/rag-retrieval-eval.test.ts test/rag-retrieval-regression.test.ts` —
  **36/36 passing** (was 10 + 19 = 29 before this change; +7 new `it`s: 4 episodic eval + 3
  multi-query, plus the 10 new fixture cases flow through the existing filings-suite assertions
  that iterate the whole fixture array).
- Did NOT run full `npm test` / `npm run build` per this lane's stated scope (test/fixture/docs
  only) and the task instructions (focused-test verification only).

## Follow-ups

- The multi-query suite's assertions are deliberately no-regression + plumbing-only, not a claimed
  recall improvement, because this harness's mock returns the SAME recorded pool for every
  fan-out variant (there's no "different pool per paraphrase" concept in a static fixture) — a real
  improvement claim would need either a richer mock (a per-query-variant pool) or a live-index
  eval, both out of scope here. Documented inline in the test file.
- If a future lane wants to measure multi-query's REAL recall delta (not just prove the plumbing
  runs), the natural next step is a fixture variant where each derived query has its own recorded
  pool with a DIFFERENT subset of the gold/near-miss chunks surfaced at high cosine rank — letting
  `rrfFuse` combine genuinely complementary signal instead of fusing N copies of one list.
- `coach-note`/`lesson` doc types are covered by fixture text shape only (hand-authored to match
  the documented format in `experience-memory.ts`'s module header); no production writer for
  `coach-note`/`lesson` vectors was inspected as part of this task (out of scope — TEST/FIXTURE/
  DOCS ONLY).
