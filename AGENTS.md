# Agent Instructions

Read this before making changes. It exists to save you (and whichever other AI
tool touches this repo next — Claude Code, Codex, Antigravity/Gemini, Cursor,
etc.) the time/tokens of re-deriving things a previous session already learned
the hard way.

## Before you start

- `git status` and `git log -3` first. Another tool may have left uncommitted
  work in the tree — read it before editing on top of it, don't assume a clean
  base.
- Check `docs/*.md` for an existing design doc on the area you're touching
  before writing a new one. If you're replacing one, say so explicitly in the
  commit message — don't silently delete+replace without a paper trail (this
  has happened: `docs/phase-7-strategy-learning-loop.md` was fully replaced by
  `docs/phase-7-strategy.md` with a different design, no commit explained it).
- Read `STATUS.md` for the current repo snapshot, then skim the most relevant
  `docs/*.md` and the latest matching note under `docs/rollouts/` before making
  a non-trivial change.

## Documentation workflow

- `AGENTS.md` is for durable repo rules and cross-file traps only. Do not put
  turn-specific status or a running changelog here.
- `STATUS.md` is the current snapshot. Update it when the project's active
  focus, risks, verification state, or next steps materially change.
- `docs/*.md` are design docs. Use them for architecture, invariants, tradeoffs,
  and implementation sequencing for a feature area or phase.
- `docs/rollouts/YYYY-MM-DD-short-slug.md` are chronological handoff notes.
  Add or update one when a non-trivial change lands, a design direction shifts,
  or important verification/blockers need to be preserved for the next tool.
- `PLAN.md` remains the high-level roadmap. Do not use it as a substitute for
  rollout notes or current status.
- If you replace an existing design doc, call that out explicitly in both the
  commit message and the relevant rollout note.
- Prefer short factual notes with exact file paths, exact commands, and explicit
  follow-ups over long narrative summaries.
- Separate pre-existing failures from failures introduced by your change.

## Rollout note minimums

- Summary: what changed.
- Why: why it changed or what decision was made.
- Files: exact touched paths.
- Verification: exact commands actually run, plus notable failures if any.
- Follow-ups: remaining work, risks, or deferred items.
- If no code changed but an important decision or blocker was discovered, write
  the note anyway and say that explicitly.

## Verify before claiming done

Run all three, in this order, before saying a change is complete:

```bash
npx tsc --noEmit   # type errors — fast, do this first
npm test           # vitest, ~76 tests across 10 suites
npm run build      # full Next.js build; also re-checks types
```

`npm run build` deletes and regenerates `.next/`. If a dev server is running
(via Claude Code's preview tool or otherwise), it will start erroring with
`ENOENT .next/server/...` afterward — restart it.

Because `tsconfig.json` includes `.next/types/**/*.ts`, `npx tsc --noEmit` can
also fail when those generated files are missing or stale. If that happens,
capture the exact missing-path error in your rollout note and treat a fresh
`npm run build` as the authoritative regeneration step before re-checking.

If `npx tsc --noEmit` reports errors in `test/alternative-data.test.ts` around
a `mockFetcher`/`URL | RequestInfo` type mismatch — that's pre-existing and
unrelated to most changes; don't spend time chasing it unless you're touching
that file directly.

## Cross-file consistency traps (cheap to check, expensive to miss)

- **`TradeProposal`** (`src/lib/types.ts`) requires `tradeThesisTag` and
  `entryMarketRegime` as non-optional strings. Every place that *constructs* a
  `TradeProposal` literal must set them — this includes test fixtures, not just
  production code. Grep `side: "buy"` or `side: "sell"` in `test/*.ts` to find
  construction sites if you change this type again.
- **`OrderSide`** (`src/lib/types.ts`) is `"buy" | "sell" | "short" | "cover"`.
  ⚠️ As of this writing, `short`/`cover` are accepted by the LLM's proposal
  schema (`src/lib/strategy.ts`) but **not yet handled** by the risk/PnL layer:
  `src/lib/policy.ts` (`evaluateTradeProposal`, notional/exposure checks),
  `src/lib/performance.ts` (`calculatePnl` FIFO lot accounting), and
  `src/lib/db.ts` (`isBuy` daily-notional tracking) all still branch only on
  `=== "buy"` / `=== "sell"`. If you touch any of these files, check whether
  `short`/`cover` need a branch too — don't assume the binary check is
  exhaustive just because it was written before this type changed. See
  `docs/phase-7-strategy.md` section C for the intended guardrails (hard
  stop-loss, stricter notional cap) — none of that is implemented yet.
- **Per-field enrichment sourcing** (`src/lib/data-providers.ts`): when adding
  a new enriched field (e.g. another fundamentals metric), wire it through all
  of: the `SymbolEnrichment` interface, `EnrichmentSourcedField` union, the
  `takeScalar(...)` calls in `CascadingEnrichmentProvider.enrich`, the
  `EMPTY_SOURCED` marker map, and the corresponding field on `MarketQuote` /
  `MarketQuoteSummary` in `types.ts` + the merge in `src/lib/market.ts`. Missing
  any one of these means the value silently never reaches the dashboard.
- **Never label real data "mock" or "fallback" in anything user-facing.** The
  enrichment cascade used to end in a synthetic mock tier; it was deliberately
  removed because showing fabricated numbers next to real ones is misleading.
  Yahoo Finance (no API key required) is the floor now — every symbol gets real
  data or the cell shows `-`/`n/a`, never a fake number.

## Conventions

- Source attribution: `MarketScan.source` is a `+`-joined list of every
  provider that actually contributed data this run (e.g.
  `"nasdaq-delayed-screener+finnhub+yahoo-finance+robinhood-quotes"`). Don't
  hardcode a provider name into this string — derive it from what ran.
- P/E ratio display: `"n/a"` means negative/zero earnings (a real, computed
  "no ratio" state); `"-"` means the data simply wasn't available. These are
  not interchangeable — check `eps` to decide which one applies.
- Tests use a temp SQLite file per run via `DATABASE_URL=file:<tmpdir>/...`
  (see `beforeAll` in test files) — don't point tests at the dev `data/app.db`.

## Don't

- Don't run destructive git operations (`reset --hard`, force-push, branch
  deletion) without explicit user confirmation in the current conversation,
  even if a previous session was authorized to push.
- Don't place real trades or toggle `paperMode: false` while testing — Paper
  mode is the default for a reason.
