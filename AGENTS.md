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

## Pre-Commit / Handoff Protocol (Claude, Codex, Antigravity, Cursor, etc.)

Before every commit/push to the GitHub repo, you MUST update the following:
1. **`STATUS.md`** — current state, blockers, next action.
2. **`docs/rollouts/YYYY-MM-DD-short-slug.md`** — create or update a chronological rollout note detailing what was done, decisions made, what's next, exact touched files, and verification commands run. Do NOT use a single `HANDOFF.md` file, use the rollouts directory.
3. **`PLAN.md`** — reflect any scope, timeline, or approach changes.
4. **Phase docs (`docs/*.md`)** — update the relevant phase doc to match actual implementation state.
5. **Other touched docs** — README, architecture docs, API specs, etc.
6. **Commit Messages** — every commit message should reference which docs were updated.

`AGENTS.md` is for durable repo rules and cross-file traps only. Do not put turn-specific status or a running changelog here.

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
npm test           # vitest, ~195 tests across 27 files as of 2026-06-18
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

## Hosting & dev servers (multi-agent coordination)

This repo is touched by several AI tools (Claude Code, Codex, Antigravity/Gemini).
There are **three separate git worktrees of the same repo**, each with its OWN
`node_modules`, `.next`, `data/app.db`, and `.env.local` — never assume any of
those are shared, and never point one worktree's process at another's files:

| Worktree | Port | Process | Purpose |
|----------|------|---------|---------|
| the edit worktree(s) you work in (e.g. `~/Documents/Robinhood Agentic Trading`) | 3000/3001/3002 *(ephemeral, optional)* | `next dev` | where agents edit + run `tsc`/`test` |
| `~/apps/trading-preview` | **4100** | pm2 `trading-preview` → `next start` | shared **hosted preview** of committed `main` |
| `~/apps/trading-live` | **4000** | pm2 `trading` → `next start` | **production** (`trading.jays.services` via Cloudflare tunnel) |

### Prefer the hosted preview over your own dev server
- For "does it work in a browser" checks, use the **:4100 preview** instead of
  spinning up a session-bound dev server. After you commit to `main`, refresh it:
  `scripts/refresh-preview.sh` (defaults to `origin/main`; pass a ref to override).
  It runs from `~/apps/trading-preview` under pm2, so it is **never** disturbed by
  anyone's `npm run build` and does not collide with the edit worktree's `.next`.
- The preview and production are pm2 apps. `pm2 restart trading-preview` / `pm2 list`
  are fine; do **not** `pm2 delete`/rename them, and run `pm2 save` after intentional
  changes. Never run `npm run build` or `next dev` *inside* `~/apps/trading-preview`
  or `~/apps/trading-live` to "see your edits" — that builds mid-serve and 500s the
  hosted instance; use the refresh script (preview) or the deploy steps (production).

### A running dev port is NOT a work lock
A dev/preview server listening on a port does **not** mean another agent is mid-task.
Do not infer "someone is working" from an open 3000/3001/3002/4100/4000. Coordinate
ONLY via `git status` / `git log` and `STATUS.md`. If you still want live HMR of your
own *uncommitted* edits, you may run an ephemeral dev server on your lane and treat it
as disposable and yours:
- **Claude Code → 3000** (its preview tool defaults here).
- **Codex → 3001** (`npm run dev:codex`; must not take 3000).
- **Antigravity/Gemini → 3002** (`next dev -p 3002`; must not take 3000).
- Keep the shared `npm run dev` script **unpinned** (defaults to 3000); override the
  port via flag/env — never hardcode a port into `dev`. Don't kill another lane's port.

Host-local deployment details (tunnel, pm2 ecosystem) live in `~/apps/README.md` on
the deployment machine.

## Cross-file consistency traps (cheap to check, expensive to miss)

- **`TradeProposal`** (`src/lib/types.ts`) requires `tradeThesisTag` and
  `entryMarketRegime` as non-optional strings. Every place that *constructs* a
  `TradeProposal` literal must set them — this includes test fixtures, not just
  production code. Grep `side: "buy"` or `side: "sell"` in `test/*.ts` to find
  construction sites if you change this type again.
- **`OrderSide`** (`src/lib/types.ts`) is `"buy" | "sell" | "short" | "cover"`.
  `src/lib/policy.ts` and `src/lib/performance.ts` now include short/cover
  branches, but this is still high-risk code. If you touch risk, P&L, order
  accounting, or persistence, verify all four sides explicitly. In particular,
  check `src/lib/db.ts` daily-notional tracking before assuming short/cover are
  fully production-ready.
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
