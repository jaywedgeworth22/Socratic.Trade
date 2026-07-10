# 2026-07-10 — Mistral keyed re-benchmark (MONET, owner-directed)

## Summary

The keyed re-benchmark deferred from PR #1279 (Mistral capability-map fix) ran tonight,
owner-directed. **12/12 calls succeeded — zero 400s** (the 2026-07-08 benchmark was 0/12
under the old family-wide capability map), empirically proving the fixed request shapes
against the live Mistral API. Results committed as
`docs/benchmarks/2026-07-10-mistral-rebench.{json,md}`.

| model | role | ok | p50 | p95 | avg $/call | output |
|---|---|---|---|---|---|---|
| mistral-small-2603 | green | 3/3 | 3.6s | 4.4s | $0.0015 | 2.3 proposals avg, 100% schema-valid, 100% bracket coverage |
| mistral-small-2603 | red | 3/3 | 1.7s | 2.0s | $0.0004 | correct verdict JSON (see validator note) |
| mistral-medium-3-5 | green | 3/3 | 1.3s | 2.3s | $0.0117 | valid but EMPTY `{"proposals":[]}` every round (~8 completion tokens) |
| mistral-medium-3-5 | red | 3/3 | 1.1s | 1.3s | $0.0038 | correct verdict JSON (see validator note) |

Context vs. 2026-07-08 peers: `mistral-small-2603` as green is markedly cheaper and faster
than `gpt-5.4-mini` green ($0.0015 / 3.6s vs $0.0247 / 24.3s) with real bracket-covered
proposals. `mistral-medium-3-5` green (reasoning off — the new default) declined to propose
on the same signal snapshot all three rounds.

## Benchmark-validator artifact (red rows)

`validateProposals` in `scripts/benchmark-llm-models.ts` applies the GREEN
proposals-array check to BOTH roles, so any correctly-shaped red `red_team_verdict`
object scores `schemaValid=false` by construction. Manual inspection of all six red
responses: well-formed `{"verdict":"reject","reason":...}` JSON, and the reasoning was
substantively correct (both models fact-checked the fixture's bull-says-BUY vs
trades-are-SELLs incongruity). Follow-up: teach the script a red-role validator keyed on
`RED_TEAM_VERDICT_SCHEMA` so red rows report honestly.

## How it ran

From this worktree (post-#1279 request shapes) under Node 24, with
`DATABASE_URL=file:~/apps/trading-live/data/app.db` (read-only source of the real
signal-snapshot prompt data) and `MISTRAL_API_KEY` + `ENCRYPTION_KEY` resolved at runtime
from Infisical prod via the automation machine identity (values never written to disk or
logs):

```bash
npx tsx scripts/benchmark-llm-models.ts --models mistral-small-2603,mistral-medium-3-5 \
  --rounds 3 --role both
```

## Rotation-pool recommendation (owner call — pool NOT changed in this PR)

- `mistral-small-2603`: meets the re-add gate as a GREEN proposer (100% schema-valid,
  cheap, fast, brackets populated). Its red verdicts are correctly shaped too. Reasonable
  to re-add.
- `mistral-medium-3-5`: request shapes work, but as green (reasoning off) it produced
  zero proposals on a real snapshot, and its reasoning tier (`reasoning_effort:"high"` +
  `prompt_mode:"reasoning"`) was NOT exercised — the benchmark script has no effort flag.
  Recommend holding it out of the pool until a high-effort probe (also the live test of
  #1279's chunked reasoning-text extraction) shows it proposes.
- Caveat that applies to any red-seat pool member: the pool is shared by both seats;
  DeepSeek precedent shows red-side strict-schema drift is tolerated in the pool today,
  and Mistral's verdicts are correct anyway.

## Files

- `docs/benchmarks/2026-07-10-mistral-rebench.json` / `.md` — committed results (checked:
  no secrets in either artifact).
- `STATUS.md`, `docs/EFFORT-LOG.md` (+ live board), this note — protocol.
- No code changes.

## Verification

- Benchmark run itself (12 live calls, all `ok`, output tables above).
- `grep -ciE "api[_-]?key|bearer|sk-..." docs/benchmarks/2026-07-10-mistral-rebench.json`
  → 0 before commit.

## Follow-ups

- Red-role validator fix in `scripts/benchmark-llm-models.ts` (artifact above).
- Optional `--effort` flag for the script, then a `mistral-medium-3-5` high-effort probe
  (exercises the reasoning tier + chunked-content extraction live).
- Owner decision on re-adding `mistral-small-2603` (and later medium-3-5) to
  `MODEL_ROTATION_POOL`.
