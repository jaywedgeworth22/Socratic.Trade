# 2026-07-04 — CI Actions efficiency (docs-only fast path + caching)

Branch `claude/ci-actions-efficiency`, worktree `~/apps/trading-wt-ci-efficiency`, off
`origin/main`. Workflow-only change; no application code touched.

## Why

The personal GitHub Actions Pro-plan quota (3,000 min/mo) was exhausted. The merge gate is a
required-status-check ruleset (`main-protection`, id `17945518`) that gates `main` on the check
named exactly `verify`. Goal: cut Actions minutes substantially with **zero weakening** of that
gate — every code/config change must still run the full lint/tsc/test/build suite unchanged; only
pure-documentation diffs get a cheap path.

## What changed

**`.github/workflows/ci.yml` only.** Restructured into two jobs:

1. **`classify`** (new, cheap, `ubuntu-latest`, no deps installed) — on `pull_request` events
   only, checks out with `fetch-depth: 0` and computes `git diff --name-only
   <base_sha>...<head_sha>`. If every changed path matches `*.md` (anywhere) or `docs/**`, it sets
   output `docs-only=true`; otherwise `false`. Conservative by construction:
   - Any non-`pull_request` event (`push`, `merge_group`) immediately sets `docs-only=false` — no
     diff is computed at all for those triggers, so pushes to `main`/`agent/**` and merge-queue
     runs always get the full gate.
   - Missing base/head SHA, no discoverable merge-base, or an empty diff listing all short-circuit
     to `docs-only=false`.
   - The classifier only ever *adds* work back (falls back to full gate); it can never force a
     skip it isn't sure about.
2. **`verify`** (existing job, same name — this is the job GitHub's ruleset polls) — now
   `needs: classify` and guards every expensive step (`checkout`, `setup-node`, the `.next/cache`
   restore, `Install dependencies`, `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run
   build`) behind `if: needs.classify.outputs.docs-only != 'true'`. When docs-only, a single step
   logs `docs-only diff — gate skipped by path filter` and the job succeeds immediately — the
   `verify` check still *reports*, it just does almost no work. The existing "Refuse untrusted PR
   source" fork/bot guard step is unconditional (still runs first, cheap, no deps).

**Why a gate-job, not `paths:`/`paths-ignore:` on the trigger:** putting a path filter on the
workflow's `on:` block would mean GitHub never even schedules a run for a docs-only PR — and a
required check that never reports stays **pending forever**, permanently blocking merge. The
`needs.classify.outputs.docs-only` step-conditional pattern keeps the job (and thus the check
name) running and reporting in both cases, satisfying the ruleset either way.

**Caching added to `verify`:** `setup-node@v4` already had `cache: npm` (keyed on
`package-lock.json` — pre-existing, unchanged). New: `.next/cache` restore via `actions/cache@v4`,
same key/restore-key pattern already used in `e2e.yml`'s Playwright job (`${{ runner.os
}}-nextjs-${{ hashFiles('package-lock.json') }}-${{ hashFiles('src/**', 'app/**') }}` with two
looser restore-key fallbacks). This warm-starts `npm run build`'s Next.js compile instead of a
cold build every run. `node_modules` itself is not cached directly — `setup-node`'s built-in npm
cache (the documented pattern) is relied on instead, consistent with the existing e2e/verify setup.

## Required-check verification

Queried the live ruleset directly rather than trusting the AGENTS.md fallback list:

```
$ gh api repos/jaywedgeworth22/agentic-trading/rulesets --jq '.[] | {id, name, target, enforcement}'
{"enforcement":"active","id":17945518,"name":"main-protection","target":"branch"}

$ gh api repos/jaywedgeworth22/agentic-trading/rulesets/17945518 \
    --jq '.rules[] | select(.type=="required_status_checks") | .parameters.required_status_checks'
[{"context":"verify"}]
```

**Only `verify` is a required status check today.** `smoke` (e2e.yml), `gitleaks` (security.yml),
and `check-pin` (shared-package-pin-check.yml) are NOT currently required by the ruleset — the
AGENTS.md doc's "verify, smoke, gitleaks, check-pin" list is described there as the fallback to use
*only if the API 404s*; it didn't 404, so the API response above is authoritative. This branch
still leaves `e2e.yml`, `security.yml`, and `shared-package-pin-check.yml` completely untouched —
the docs-only fast path was only ever applied to `ci.yml`'s `verify` job, exactly as scoped, and no
job name was renamed or removed anywhere.

Job name confirmed unchanged: `ci.yml` still defines a job literally named `verify` (now with
`needs: classify` added) — `gh pr checks` / the ruleset will see the identical context string.

## Syntax validation

```
$ npx yaml-lint .github/workflows/ci.yml
✔ YAML Lint successful.
```

Also re-ran `yaml-lint` across all seven workflow files (only `ci.yml` was modified; the rest are
unchanged, listed for completeness) — all pass.

Classification-regex sanity check (bash snippet extracted and run standalone against sample
changed-file lists): root `*.md`, `docs/**` (md or non-md), and mixed docs+root-md all correctly
classify `docs_only=true`; any code/config/package.json/workflow/public asset — alone or mixed
with docs — correctly classifies `docs_only=false`.

## Audit: workflows triggering on every PR push or every push-to-main

No changes made to any of these in this branch — report only, per the task's explicit scope.

| Workflow | Triggers | Runner | Approx. min/run | Required check? | Batching/scheduling opportunity |
|---|---|---|---|---|---|
| `ci.yml` (`verify`) | every PR push, `merge_group`, push to `main`/`agent/**` | `ubuntu-latest` (hosted) | ~4-6 min full (install+lint+tsc+test+build); ~10-20s docs-only after this change | **Yes — the only required check** | This branch's target. Full-gate minutes now scale with actual code-touching PR volume only. |
| `e2e.yml` (`smoke`) | every PR push, `merge_group`, push to `main`/`agent/**`, weekly cron (`17 9 * * 1`) | `ubuntu-latest` (hosted) | ~5-8 min (install + Playwright browser install + build + e2e) | No (not in the live ruleset today) | Good candidate for the SAME docs-only gate-job pattern used here, OR for `paths-ignore` since it isn't a required check (a pending/skipped run wouldn't block merges) — deliberately left unmodified in this branch since it's out of scope. Could also drop the redundant push-to-`agent/**` trigger if PR-level coverage is deemed sufficient. |
| `security.yml` (`gitleaks`) | every PR push, `merge_group`, push to `main`/`agent/**`, weekly cron (`41 10 * * 1`) | `ubuntu-latest` (hosted) | ~1-2 min (checkout + gitleaks scan, no npm install) | No (not in the live ruleset today) | Already cheap (no dependency install). Lowest-priority target; the docs-only fast path would save little here. Could still skip on docs-only diffs for consistency/minutes, but the marginal saving is small. |
| `shared-package-pin-check.yml` (`check-pin`) | PR push only when `package.json`/`package-lock.json`/its own workflow file changed, push to `main`, weekly cron | `ubuntu-latest` (hosted) | <1 min (no npm install, just `gh api` + `node -p`) | No (not in the live ruleset today; explicitly documented in-file as intentionally NOT part of branch protection) | Already path-filtered and cheap. No action needed. |
| `codex-autofix.yml` | `pull_request_review`, `pull_request_review_comment`, `issue_comment`, `workflow_dispatch` — NOT a blanket push/PR trigger | `ubuntu-latest` (hosted) | Variable (LLM agent loop, `timeout-minutes: 30` cap); only runs when the Codex bot actually posts feedback | No | Already conditional/event-driven, not a per-push cost. No action needed. |
| `deploy.yml` | push to `main` (i.e. every merged PR), `workflow_dispatch` | `[self-hosted, trading-live]` | Self-hosted (does not consume hosted Actions minutes) | No | Self-hosted; irrelevant to the hosted-minutes budget. No action needed. |
| `sync-previews.yml` | push to `main`, `workflow_dispatch` | `[self-hosted, trading-live]` | Self-hosted (does not consume hosted Actions minutes) | No | Self-hosted; irrelevant to the hosted-minutes budget. Could be schedule/batched (e.g. every N pushes) if the self-hosted box itself becomes a bottleneck, but that's a runner-time concern, not Actions-minutes billing. |

**Net billing-relevant takeaway:** of the hosted-runner (`ubuntu-latest`) workflows that burn the
Pro-plan Actions-minutes quota, `ci.yml` (`verify`) is the only one that is both (a) a required
check and (b) triggered on every PR push — making it the correct and highest-leverage target for
the docs-only fast path implemented here. `e2e.yml`/`security.yml`/`shared-package-pin-check.yml`
also trigger broadly and consume hosted minutes, but are not required checks; they're flagged above
as candidates for a follow-up efficiency pass, deliberately out of scope for this branch.

## Estimated savings

Assumptions: full `verify` run today averages ~5 min (install ~1-2 min, lint ~20s, tsc ~10s, test
~40-70s, build ~60-90s, plus checkout/setup overhead); a docs-only run after this change is
~15-25s (checkout + classify + the short-circuit log line, no install). Docs-only PRs
(`docs/rollouts/*.md`, `STATUS.md`, `docs/EFFORT-LOG.md`-only diffs, etc.) are common in this repo
given the Pre-Commit/Handoff Protocol's per-commit doc requirements, but exact share of total PR
volume isn't tracked — using an illustrative 15-25% range typical for a repo with this doc
discipline:

- Per docs-only PR: **~90-95% reduction** in `verify` minutes (5 min -> ~20s).
- At an illustrative 20% docs-only PR share: **~18-19% reduction in total `verify` minutes**
  across all PR pushes (0.20 x 95% + 0.80 x 0%-of-baseline, before counting the `.next/cache`
  warm-start saving on the remaining 80%).
- The `.next/cache` restore additionally shortens the `npm run build` step on every *non*-docs-only
  run once the cache is warm (subsequent runs on the same lockfile/source-hash reuse Next's
  incremental compile output) — historically a 20-40% build-step time cut in this repo's other
  workflow (`e2e.yml` already relies on the identical pattern), on top of the docs-only savings
  above.
- These are estimates, not measured production numbers — Actions quota is currently exhausted, so
  no live run of this workflow has executed yet (see Follow-ups).

## Files touched

- `.github/workflows/ci.yml` — `classify` job added; `verify` job's expensive steps now
  step-conditional on `needs.classify.outputs.docs-only`; `.next/cache` restore step added.
- `docs/rollouts/2026-07-04-ci-actions-efficiency.md` — this note.
- `STATUS.md` — prepended entry.
- `docs/EFFORT-LOG.md` — mirror row.
- `/Users/jay/apps/TRADING-EFFORT-LOG.md` — live board row (branch-neutral, not tracked in this repo).

No other workflow file was modified (`e2e.yml`, `security.yml`, `shared-package-pin-check.yml`,
`codex-autofix.yml`, `deploy.yml`, `sync-previews.yml` are byte-for-byte unchanged — confirmed via
`git diff --stat` before landing).

## Verification

Full local quartet run in the worktree (workflow-only change, but protocol is protocol):

```
npm run lint       # 0 errors, 308 pre-existing warnings (grandfathered backlog, unchanged)
npx tsc --noEmit   # clean, no output
npm test           # 249 test files, 2436 tests passed
npm run build      # succeeded, full route manifest printed
```

Plus workflow-specific checks:

```
npx yaml-lint .github/workflows/ci.yml                     # valid (and re-ran across all 7 workflow files)
gh api repos/jaywedgeworth22/agentic-trading/rulesets --jq '...'                 # confirmed ruleset id/name
gh api repos/jaywedgeworth22/agentic-trading/rulesets/17945518 --jq '...'        # confirmed required context = ["verify"] only
```

Standalone bash reproduction of the classify job's grep-based path classifier against 10 sample
changed-file lists (root `.md`, `docs/**`, mixed, package.json, workflow file, public asset, etc.)
— all classified as expected (docs-only vs. full-gate), see command history; not committed as a
test file since the logic lives entirely in workflow YAML `run:` steps, not application code.

## Follow-ups

- **No live Actions run has exercised this workflow yet** — the Pro-plan spending limit is
  reportedly at $0/exhausted, so hosted `ubuntu-latest` jobs may fail outright or sit queued until
  the owner raises the spending budget (Settings -> Billing -> Plans and usage -> Spending limit).
  `verify`'s in-file comment already documents this failure mode. Once the owner unblocks the
  budget, watch the first few PRs (one docs-only, one code-touching) to confirm the classify job's
  live GitHub Actions behavior matches this local reasoning (in particular: that
  `github.event.pull_request.base.sha`/`head.sha` are populated as expected on `pull_request`
  events, and that `needs.<job>.outputs.<x>` step-conditionals behave as designed when the
  upstream job itself has a skipped step).
- **Audit-flagged candidates for a follow-up efficiency pass** (not implemented here, out of
  scope): apply the same gate-job docs-only pattern to `e2e.yml`'s `smoke` job, and consider
  dropping/narrowing the `push: branches: [agent/**]` trigger on `ci.yml`/`e2e.yml`/`security.yml`
  if per-PR coverage is judged sufficient without also re-running on every agent-branch push.
- **No telemetry on actual docs-only PR share** — the 15-25% estimate is qualitative (based on this
  repo's heavy per-commit doc-update discipline), not measured from GitHub's Actions usage API.
  Once minutes reporting is available again, `gh api /repos/.../actions/runs` timing data could
  replace the estimate with a measured before/after number.
