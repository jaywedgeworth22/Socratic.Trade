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

## Auto-deploy (DEFAULT — skip only when told not to)

After completing any non-trivial code change and running verification
(`npx tsc --noEmit`, `npm test`, `npm run build`), **automatically deploy
without waiting to be asked**. Use the single command:

```bash
bash scripts/deploy.sh "descriptive commit message"
```

This commits, pushes, creates a PR with auto-merge, and returns to `main`.
CI verifies on the branch; once green the PR self-merges and `deploy.yml`
restarts production. The user should never have to type "deploy" or "push".

**Exception:** skip only when the user explicitly says "don't deploy this" or
"leave this uncommitted."

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

Run all four, in this order, before saying a change is complete:

```bash
npm run lint       # eslint (flat config); REQUIRED `verify` CI step — fails on errors only
npx tsc --noEmit   # type errors — fast, do this first
npm test           # vitest, ~723 tests across 81 files as of 2026-06-21
npm run build      # full Next.js build; also re-checks types
```

`npm run lint` runs `eslint .` against `eslint.config.mjs` (flat config). It is
pinned to **ESLint 9**, not 10: `eslint-config-next@16` bundles
`eslint-plugin-react@7.x`, which calls `context.getFilename()` — an API ESLint 10
removed, so ESLint 10 throws `getFilename is not a function` at load. Keep
`eslint` on `^9` until a Next/react-plugin release supports ESLint 10. ESLint
exits non-zero only on **errors**, not warnings; a large grandfathered backlog
(`@typescript-eslint/no-explicit-any`, `react-hooks/set-state-in-effect`, etc.)
is intentionally pinned to "warn" in `eslint.config.mjs` so the gate is green
today while still surfacing the debt — promote those to "error" as you burn them
down.

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

| Worktree | Branch | Port | Process | Public route | Owner |
|----------|--------|------|---------|--------------|-------|
| `~/Code/Agentic Trading` | `main` | **4001** | pm2 `trading-main` → `next dev` | `trading-beta.jays.services` | **integration / review / merges / hand-edits** (human via **Cursor**) |
| `~/apps/trading-claude` | `agent/claude` | **4100** | pm2 `trading-claude` → `next dev` | `claude.jays.services` | Claude Code |
| `~/apps/trading-codex` | `agent/codex` | **4101** | pm2 `trading-codex` → `next dev` | `codex.jays.services` | Codex |
| `~/apps/trading-antigravity` | `agent/antigravity` | **4102** | pm2 `trading-antigravity` → `next dev` | `antigravity.jays.services` | Antigravity/Gemini |
| `~/apps/trading-live` | release | **4000** | pm2 `trading` → `next start` | `trading.jays.services` | **production** |

Bootstrap / repair the integration preview and agent previews idempotently with
`scripts/setup-agent-previews.sh`.

`trading-beta.jays.services` is the only public beta/integration hostname for
the 4001 main preview. Do not add or document duplicate beta hostnames.

### Preview freshness policy

`trading-beta.jays.services` is the integration source of truth. Agent preview
sites (`codex.jays.services`, `claude.jays.services`, and
`antigravity.jays.services`) are useful for in-progress branch review, but they
must not silently drift behind beta after work lands.

- After a branch lands or beta is updated, the owning agent should pull/sync its
  own worktree from `origin/main` and restart only its own PM2 preview when the
  worktree is clean.
- If the worktree is dirty, has unmerged local work, or cannot safely sync, leave
  the preview as-is and record the stale state plus the reason in `STATUS.md` or
  the relevant rollout note. Do not overwrite another agent's local changes to
  make a preview look current.
- When demonstrating app behavior to the user, say which hostname/worktree is
  being edited or viewed. Use beta for integrated behavior, and an agent preview
  only for that agent's active branch.
- A stale agent preview is a coordination issue, not a deployment target. Fix it
  by landing/syncing/restarting the correct worktree, not by hand-copying build
  output between worktrees.

### How each agent works
- **Launch yourself in your own worktree dir** (Claude → `~/apps/trading-claude`, Codex →
  `~/apps/trading-codex`, Antigravity → `~/apps/trading-antigravity`). Edit only there, on
  your `agent/<name>` branch. Your **live in-progress edits** appear at your port via HMR —
  open it in a browser; no refresh/rebuild needed.
- **Do not edit in another agent's worktree, nor in the `main` integration worktree.**
- **Land work via the landing script — never push directly to main:**
  ```bash
  bash scripts/land.sh
  ```
  This script: (1) refuses to run from the main integration worktree or on branch `main`;
  (2) refuses dirty/uncommitted files; (3) fetches origin; (4) refuses to auto-merge when
  your branch and `origin/main` both touched the same files since the branch forked (manual
  review required to avoid stale UI/text/behavior landing without a Git conflict); (5) merges
  `origin/main` — aborts on conflict so you can resolve; (6) runs `npx tsc --noEmit` →
  `npm test` → `npm run build` — aborts on any failure; (7) allows `.github/workflows/` changes
  when the gh token has the `workflow` scope (it does now — `git push` goes through
  `gh auth git-credential`, so agents can push CI changes directly; the old `ci-pending/` staging
  is only the fallback if the scope is ever missing — `gh auth refresh -h github.com -s workflow`);
  (8) pushes your agent branch and opens a PR via `gh`.
  After a conflict or failure, fix it and re-run `land.sh` — it is idempotent.
- **A git pre-push hook blocks direct pushes to `main`.** It is installed in every worktree
  by `setup-agent-previews.sh` via `git config core.hooksPath scripts/githooks`. The hook:
  - Refuses any push whose remote-ref is `refs/heads/main` (catches both `git push origin main`
    and `git push origin agent/foo:main`).
  - Refuses any push originating from `~/Code/Agentic Trading` (integration worktree).
  - Emergency human override (use sparingly): `HOOKS_ALLOW_MAIN_PUSH=1 git push origin ...`
- **`npm run build` only affects YOUR worktree.** If a build wipes your `.next` and your live
  preview starts erroring (`ENOENT .next/...`), restart it: `pm2 restart trading-<you>`.
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
  is the real file and `CLAUDE.md` is a symlink to it, so both carry the same content (incl. the
  Pre-Commit / Handoff Protocol above) — edit `AGENTS.md` to change either. Before
  any commit from Cursor, update `STATUS.md` + a `docs/rollouts/` note + `PLAN.md` like every
  other tool.

### A running port is NOT a work lock
A dev/preview server listening on a port does **not** mean another agent is mid-task. Do not
infer "someone is working" from an open 4001/4100/4101/4102/4000 (or a stray 3000/3001/3002).
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
  check daily-notional tracking before assuming short/cover are fully
  production-ready — it now lives in `src/lib/db-execution.ts` (see next note).
- **`src/lib/db.ts` is now a barrel, not a monolith.** As of 2026-06-21 it was split
  into eight focused modules — `db-settings`, `db-learning`, `db-profiles`,
  `db-execution`, `db-proposals`, `db-fills`, `db-notifications`, `db-api-keys` — and
  `db.ts` keeps only schema/migration/`getDb()`/`audit()` plus `export * from
  "./db-*"` re-exports. Consumers still `import { X } from "./db"` unchanged. When
  editing persistence, edit the owning module; when adding a NEW table, put the
  `CREATE TABLE` in `db.ts`'s `migrate()` and the CRUD in the matching `db-*` module
  (this split-vs-modified boundary is a known merge-conflict trap — see
  `docs/rollouts/2026-06-21-db-split-v2.md`).
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
- **Operator/deploy shell scripts must stay ASCII-only.** The production box is a
  Mac, so `bash scripts/foo.sh` runs Apple's `/bin/bash` 3.2.57, which mis-parses a
  non-ASCII byte placed **directly adjacent to a `$VAR`** (e.g. `"...$SHARED_PROJECT_ID…"`):
  it swallows a byte into the identifier and dies under `set -u` with a cryptic
  `SHARED_PROJECT_ID?: unbound variable` (the `?` is the stray byte). Non-adjacent
  decoration prints fine, so the failure looks impossible until you spot the one
  `$VAR`-adjacent glyph. Keep `scripts/*.sh` pure ASCII — use `...`/`-`/`->`, never
  `…`/`—`/`→`; check with `grep -nP '[^\x00-\x7F]' scripts/*.sh` and the
  `\$\{?\w+\}?[^\x00-\x7F]` adjacency pattern. Cost this the hard way once:
  `docs/rollouts/2026-06-26-infisical-universal-auth.md`.

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

## Git author identity (GitHub email privacy)

The owner's real email must **never** be published to the public GitHub repo. When committing or
pushing to GitHub, every commit's author/committer email MUST be the owner's GitHub **noreply**
address:

```
12656028+jaywedgeworth22@users.noreply.github.com
```

**Where the email is configured:**

- **Global** (`~/.gitconfig`, `git config --global user.email`) = the owner's real email
  `mail@jaywedgeworth.com`. This is correct for the owner's *other* repos — do not change it.
- **This repo** overrides that with a repo-local `user.email` set to the noreply address. Because
  `extensions.worktreeConfig` is **off**, a repo-local `git config user.email` lives in the shared
  `.git/config` and applies to **all** linked worktrees (`~/apps/trading-claude`, `-codex`,
  `-antigravity`, `-live`, the `main` integration tree, and any temporary `git worktree add` dirs).

**Rules for every agent (Claude, Codex, Antigravity, Cursor):**

- Before committing, confirm `git config user.email` resolves to the noreply address. If you ever see
  `mail@jaywedgeworth.com` as the effective email in a worktree, fix it before committing:
  `git config user.email "12656028+jaywedgeworth22@users.noreply.github.com"` (writes the shared
  repo-local config — covers all worktrees).
- The repo-local config is **not tracked**, so a fresh clone or a config reset loses it — restore it
  with the command above. New `git worktree add` dirs inherit it automatically.
- If a commit was already made with the real email, amend before pushing:
  `git config user.email "12656028+jaywedgeworth22@users.noreply.github.com" && git commit --amend --reset-author --no-edit`.

## Pull requests

- **Every branch intended to land on `main` gets a PR.** Don't push a feature
  branch and leave it without one. (Long-lived integration/release branches like
  `main` and the `agent/*` lanes, throwaway experiments, and stacked-PR bases are
  the only exceptions — none of which is normal change delivery.)
- **Open PRs as READY for review by default — not as drafts.** The owner is
  effectively the sole approver, so a draft only adds a "mark ready" step before
  merge. This rule **overrides** any tool/harness default that says to open PRs as
  drafts.
- **Use a draft PR only for genuine work-in-progress** you explicitly don't want
  merged yet (e.g. partial work parked between sessions, or wanting Copilot/CI eyes
  before it's finished) — and say so in the PR description. Mark it ready as soon
  as it's complete and verified.
- **A required `verify` CI check gates every merge to `main`.** A GitHub Actions
  workflow named `verify` runs `tsc --noEmit` → `npm test` → `npm run build` on each
  PR, and it **must be green before the PR can merge** — enforced by a repo **ruleset**.
  Notes that bite if you don't know this:
  - The check is a *ruleset*, not classic branch protection — `gh api
    repos/.../branches/main/protection` returns **404 "Branch not protected"**, which
    looks unprotected but is NOT.
  - `gh pr merge <n> --squash --admin` does **NOT** bypass it (`Required status check
    "verify" is failing`). Don't waste time on `--admin`.
  - **Merge with `gh pr merge <n> --squash --auto`** — auto-merge IS enabled on this
    repo, so this lands the PR the instant `verify` goes green (no babysitting).
  - If `verify` fails on a known flake (e.g. a timing-sensitive test), re-run just the
    failed jobs: `gh run rerun <run-id> --failed`. The `approval-lock` broker-path
    tests were a recurring offender — fixed 2026-06-21 with a 20s per-test timeout.
  - Because `verify` runs `npm run build`, a PR that breaks the build cannot merge —
    always run the full tsc/test/build trio locally before pushing.

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
- Run the dev server with `npm run dev` (Next.js on port `3000`).
  Do not use `npm run dev:codex` (port 3001) or `npm run dev:clean` (it kills
  port 3000). `npm run build` deletes/regenerates `.next/`, so restart `npm run
  dev` after a build.
- When opening the dev server in a browser, use `http://localhost:3000`, NOT
  `http://127.0.0.1:3000`. Next 16 blocks cross-origin dev resources (the
  `/_next/webpack-hmr` socket) from the `127.0.0.1` origin by default, so HMR /
  live-reload breaks and the console logs a "Blocked cross-origin request"
  warning. The page still server-renders either way; `localhost` just avoids the
  block without needing an `allowedDevOrigins` code change. `curl`/API checks
  against `127.0.0.1:3000` are unaffected.
- Standard verification commands live in `README.md`/the "Verify before claiming
 done" section: `npm run lint`, `npx tsc --noEmit`, `npm test` (vitest), `npm run
 build`. All pass clean in this environment.
- `npm run lint` is now configured (`eslint.config.mjs`, flat config extending
 `eslint-config-next`) and is a REQUIRED step in the `verify` CI gate. It is
 pinned to ESLint 9 (ESLint 10 is incompatible with `eslint-config-next@16`'s
 bundled react plugin — see the "Verify before claiming done" section). It fails
 only on errors; an existing backlog is grandfathered to "warn".
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

### Production ops snapshot (remote diagnostics)

Cloud agents cannot OAuth into `trading.jays.services` or read the Mac's `data/app.db`.
When investigating **live** strategy runs, multi-account behavior, or production errors,
**run first**:

```bash
bash scripts/fetch-prod-ops-snapshot.sh
```

**One-time owner setup (both sides must use the same token):**

1. Generate: `openssl rand -hex 32`
2. **trading-live:** set `OPS_DIAGNOSTIC_TOKEN=<token>` in Infisical / `.env.local`, `pm2 restart trading`
3. **Cursor Cloud Secrets** (Dashboard -> Cloud Agents -> Secrets): add `OPS_DIAGNOSTIC_TOKEN` as a
   **Runtime Secret**, scoped to this repo. Value must match production.

The script calls `GET /api/ops/snapshot` (token via `x-ops-token`). See
`docs/rollouts/2026-06-29-ops-diagnostic-snapshot.md`. Rule: `.cursor/rules/ops-diagnostics.mdc`.
