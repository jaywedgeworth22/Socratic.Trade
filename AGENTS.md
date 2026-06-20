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
**Each agent works in its OWN git worktree, on its OWN branch, with its OWN PM2-hosted
live `next dev` preview on its OWN port.** Every worktree has its own `node_modules`,
`.next`, `data/app.db`, and `.env.local` — never assume any are shared, and never point
one worktree's process at another's files.

| Worktree | Branch | Port | Process | Owner |
|----------|--------|------|---------|-------|
| `~/Code/Agentic Trading` | `main` | — (no dev server) | — | **integration / review / merges / hand-edits** (human via **Cursor**) |
| `~/apps/trading-claude` | `agent/claude` | **4100** | pm2 `trading-claude` → `next dev` | Claude Code |
| `~/apps/trading-codex` | `agent/codex` | **4101** | pm2 `trading-codex` → `next dev` | Codex |
| `~/apps/trading-antigravity` | `agent/antigravity` | **4102** | pm2 `trading-antigravity` → `next dev` | Antigravity/Gemini |
| `~/apps/trading-live` | release | **4000** | pm2 `trading` → `next start` | **production** (`trading.jays.services`) |

Bootstrap / repair the agent previews idempotently with `scripts/setup-agent-previews.sh`.

### How each agent works
- **Launch yourself in your own worktree dir** (Claude → `~/apps/trading-claude`, Codex →
  `~/apps/trading-codex`, Antigravity → `~/apps/trading-antigravity`). Edit only there, on
  your `agent/<name>` branch. Your **live in-progress edits** appear at your port via HMR —
  open it in a browser; no refresh/rebuild needed.
- **Do not edit in another agent's worktree, nor in the `main` integration worktree.**
- **Land work via git:** commit on your `agent/<name>` branch, then merge to `main` (in the
  integration worktree; ff or PR). `git merge origin/main` into your branch to stay current.
- **`npm run build` only affects YOUR worktree.** Verify with `npx tsc --noEmit` + `npm test`;
  if a build wipes your `.next` and your live preview starts erroring (`ENOENT .next/...`),
  just `pm2 restart trading-<you>`. It never affects another agent or production.
- **PM2:** `pm2 restart trading-<you>` / `pm2 list` are fine; do **not** `pm2 delete`/rename
  another agent's app or `trading`; run `pm2 save` after intentional changes. Never run a
  build/`next dev` *inside* `~/apps/trading-live` (production) to preview edits — deploy there
  via its release steps only.

### Cursor: the human review cockpit (not a 4th agent lane)
Cursor fills the **human-in-the-loop** seat, not a fourth autonomous agent. The three
CLI/agentic tools (Claude Code, Codex, Antigravity) *produce* work in parallel `agent/*`
worktrees; Cursor is where a human *reviews, steers, hand-edits, and integrates* it. Its home
is the existing **`main` integration worktree** (`~/Code/Agentic Trading`) — no new port, no
PM2 preview.

- **Best uses:** reviewing/merging the `agent/*` branches (inline-AI diff reading + merge-
  conflict resolution), fast surgical hand-edits where firing a whole agent is overkill,
  in-editor debugging, and codebase Q&A while you steer.
- **Don't** make `main` an autonomous lane or stand up an `agent/cursor` dev-server worktree to
  run a 4th parallel agent — it adds a branch to merge and a preview to babysit for little gain
  over the three you already have.
- **If you do use Cursor's agent/background mode** for a feature, keep it on its own branch like
  the others. It already does this: background runs land on `cursor/*` branches (e.g.
  `origin/cursor/setup-dev-environment-*`) — merge them like any `agent/*` branch.
- **Handoff still applies.** Cursor auto-loads `AGENTS.md` (and `.cursor/rules/`); `AGENTS.md`
  *is* `CLAUDE.md` (symlink) and already carries the Pre-Commit / Handoff Protocol above. Before
  any commit from Cursor, update `STATUS.md` + a `docs/rollouts/` note + `PLAN.md` like every
  other tool.

### A running port is NOT a work lock
A dev/preview server listening on a port does **not** mean another agent is mid-task. Do not
infer "someone is working" from an open 4100/4101/4102/4000 (or a stray 3000/3001/3002).
Coordinate ONLY via `git status` / `git log` / the branch list and `STATUS.md` — never by
inspecting ports. The legacy per-agent ephemeral dev lanes (Claude 3000 / Codex 3001 via
`npm run dev:codex` / Antigravity 3002) are superseded by the PM2 worktree previews above;
use them only as a one-off and treat them as disposable.

Host-local deployment details (tunnel, pm2 ecosystem) live in `~/apps/README.md` on the
deployment machine.

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

## Cursor Cloud specific instructions

These notes apply when running in the Cursor Cloud agent VM. They override the
host-machine "Hosting & dev servers" section above, which describes the user's
local multi-worktree/PM2 setup and does NOT apply here.

- The Cloud VM is a single `/workspace` checkout. There are no per-agent
 worktrees, no PM2 processes, and no ports 4100/4101/4102/4000 — ignore that
 entire worktree/PM2 table for cloud work.
- Run the dev server with `npm run dev` (Next.js on `http://127.0.0.1:3000`).
 Do not use `npm run dev:codex` (port 3001) or `npm run dev:clean` (it kills
 port 3000). `npm run build` deletes/regenerates `.next/`, so restart `npm run
 dev` after a build.
- Standard verification commands live in `README.md`/the "Verify before claiming
 done" section: `npx tsc --noEmit`, `npm test` (vitest), `npm run build`. All
 pass clean in this environment.
- `next lint` is NOT configured (no eslint config is committed); it drops into
 an interactive setup prompt, so it is not part of verification. Use the
 tsc/test/build trio instead.
- No secrets or API keys are required to run the app. It defaults to **Test
 mode** (a local SQLite simulator at `data/app.db`) and the Market Scan pulls
 live Yahoo Finance quotes with no key. `DATABASE_URL` defaults to
 `file:./data/app.db` (`src/lib/db.ts`), so the app runs even without a
 `.env.local`. Copy `.env.example` → `.env.local` only when you need to set
 optional provider keys.
- The LLM agentic loop ("Run once" / `decide` autonomy) needs `OPENAI_API_KEY`.
 Without it, the dashboard, market scan, watchlist/policy/account configuration,
 and Test-mode simulation all still work — only LLM-driven proposal generation
 is unavailable.
