# 2026-07-04 — Hybrid resource-aware runner routing for the `verify` gate

Branch `claude/ci-hybrid-runner-verify`, worktree `~/apps/trading-wt-ci-efficiency`, off
`origin/main` at `370692cf` (immediately after PR #370 merged). Own clearly-labeled PR by
explicit owner instruction — deliberately NOT bundled into #370.

## History and decision record (required reading before touching this again)

1. **2026-07-01:** `verify` was deliberately moved OFF the self-hosted `trading-live` Mac runner
   onto `ubuntu-latest` (PR #285 lineage; see the old ci.yml comment) because the single Mac
   runner was serializing a backlog of CI runs — "the main source of the runner queue
   bottleneck."
2. **2026-07-04 (this task's first round):** hybrid self-hosted/hosted routing was proposed
   mid-task. The implementing agent escalated back instead of building, with three objections:
   (a) **contention** — the Mac is the production box (pm2 `trading`, live trading process);
   running 2,436 tests + a Next build on it risks CPU/RAM contention with production;
   (b) **bottleneck** — a `max-in-flight 1` self-hosted lane is by definition the serialization
   the 2026-07-01 change eliminated;
   (c) **gate determinism** — a required check whose result depends on which of two OS/toolchain
   environments (macOS ARM64 vs Linux x64) happened to execute it weakens what "verify passed"
   means.
3. **2026-07-04 (owner re-confirmation):** the owner re-confirmed hybrid AFTER seeing those
   objections, with a resource-aware design that answers each one. Verbatim intent: **"hybrid so
   that it only uses local when there is sufficient extra CPU/RAM available."** The design below
   is that answer, point by point:
   - (a) answered by the **availability publisher**: the Mac itself advertises capacity only
     when 1-min loadavg/ncpu < 0.6 AND free+inactive RAM > 6 GB AND the runner process is alive
     AND pm2 `trading` is online — with hysteresis (2 consecutive available checks to flip to
     self, instant flip to hosted on any busy check). Self-path gate commands additionally run
     under `nice -n 19`, so the trading process always outbids CI for CPU.
   - (b) answered by **instant hosted fallback**: the router reads the published state natively
     from `vars.VERIFY_RUNNER_STATE` (no API call); mode!=self OR ts stale >5 min OR var absent
     → hosted immediately. A busy or asleep Mac never queues anything; the self-hosted
     concurrency-1 group is a load-shed detail, not the throughput path.
   - (c) answered by **Linux as arbiter**: a verify-self FAILURE triggers exactly one automatic
     hosted re-run and the required gate takes the hosted result on disagreement — a
     Mac-environment flake can never block or fake-fail a merge. A self-hosted PASS stands (the
     suite is environment-agnostic by design and macOS is exercised daily by every local gate
     run on this fleet). A nightly scheduled hosted full-gate canary on `main` maintains a
     continuous Linux baseline, and the gate summary annotates which environment produced the
     accepted result on every run (the audit receipt).

## What changed

### `.github/workflows/ci.yml` — restructured from 2 jobs to 4

- **`classify`** (existing, extended): now also emits a `route` output (`self`|`hosted`).
  Routing rules, all fail-safe to hosted: only `pull_request`/`push` events are eligible
  (merge_group/schedule/dispatch always hosted); fork PRs never route self; absent variable,
  non-`self` mode, corrupt JSON, stale ts (>300 s), or negative age (clock skew) all route
  hosted. The state JSON is passed via `env:` (not inline interpolation) so quoting can't break
  the script.
- **`verify-self`** (new): the opportunistic macOS lane. Runs only when routed self and the
  diff is not docs-only. `runs-on: [self-hosted, trading-live]`, `timeout-minutes: 30`,
  job-level `concurrency: verify-self-hosted` (max 1, no cancel). Steps mirror the hosted lane
  plus: the same untrusted-source guard, a node fail-fast sanity step, and `nice -n 19` on
  every heavy command (install/lint/tsc/test/build). Uses the same cache keys — `runner.os` =
  `macOS` gives it an automatically separate cache namespace from the Linux lineage.
- **`verify-hosted`** (new name for the old verify body): the deterministic Linux lane. Runs
  when routed hosted OR as the exactly-one automatic re-run whenever verify-self did not
  succeed (failure, timeout, unexpected skip). Also now saves the Linux `.next/cache` on the
  nightly schedule leg (not just main pushes) so the Linux cache stays fresh even during
  stretches where every main push routes to the Mac.
- **`verify`** (the REQUIRED check, now a pure gate job): interprets the lanes and reports
  under the exact context name the ruleset requires. Decision table below. Writes the
  environment-attribution receipt to the job log and `$GITHUB_STEP_SUMMARY` on every run.
  Uses `if: ${{ !cancelled() }}` (not `always()`) so superseded-run cancellation still works
  while classify/lane failures can never silently skip the required check.
- **`schedule` trigger added** (`47 7 * * *` UTC ≈ 01:47/02:47 America/Chicago): the nightly
  hosted full-gate canary on `main`.

### `scripts/runner-availability.sh` — new Mac-side publisher (owner-run)

Pure-ASCII bash (Apple bash 3.2-safe, `bash -n` verified against `/bin/bash` 3.2.57). Every
60 s: computes availability per the formula above and publishes
`VERIFY_RUNNER_STATE = {"mode":"self"|"hosted","ts":<epoch>}` via `gh api` PATCH (POST-creates
the variable if missing). Hysteresis: 2 consecutive available checks before `self`; any single
busy check flips `hosted` immediately. An EXIT/INT/TERM trap publishes `hosted` on shutdown so
a stopped publisher fails toward hosted even before staleness kicks in. All thresholds
env-tunable (`RUNNER_AVAILABILITY_LOAD_THRESHOLD`, `_MIN_FREE_RAM_GB`, `_HYSTERESIS`,
`_INTERVAL`, `_PM2_APP`, `_RUNNER_PATTERN`, `_REPO`).

**Owner activation (one-time, idempotent — NOT performed by the agent):**

```bash
pm2 start ~/apps/trading-live/scripts/runner-availability.sh \
  --name runner-availability --interpreter bash && pm2 save
```

Until this is run, `VERIFY_RUNNER_STATE` stays at its safe default (`{"mode":"hosted","ts":0}`,
created by the agent via the API on 2026-07-04) and **everything routes hosted — merging this
PR changes no behavior until the owner activates the publisher.** Deactivation is equally
simple: `pm2 stop runner-availability` (the trap publishes hosted; staleness is the backstop).

## Gate decision table

| classify | docs-only | route | verify-self | verify-hosted | `verify` gate result | Annotated environment |
|---|---|---|---|---|---|---|
| failure/cancelled | — | — | skipped | skipped | **FAIL** (fail-closed) | — |
| success | true | — | skipped | skipped | **PASS** ("docs-only diff — gate skipped by path filter") | none (no suite ran) |
| success | false | hosted | skipped | success | **PASS** | hosted ubuntu-latest |
| success | false | hosted | skipped | failure | **FAIL** | — |
| success | false | self | success | skipped | **PASS** | self-hosted macOS |
| success | false | self | failure/timeout | success | **PASS** (disagreement noted; Linux arbiter) | hosted ubuntu-latest (arbiter) |
| success | false | self | failure/timeout | failure | **FAIL** (both lanes agree or Linux fails) | — |
| any run cancelled (superseded push) | — | — | — | — | gate skipped with the run (`!cancelled()`) — new run supersedes | — |

## Failure-mode table (operational)

| Failure | Behavior | Recovery |
|---|---|---|
| Publisher not started / stopped | Var absent or shutdown-trap published hosted; stale after 5 min regardless | Everything routes hosted (the pre-activation default state) |
| Mac busy (load/RAM), trading restarting, runner dead | Publisher flips hosted immediately (no hysteresis on the busy direction) | Routes hosted; flips back only after 2 consecutive available checks |
| Mac dies suddenly INSIDE the 5-min freshness window with a job already routed self | verify-self sits queued on the offline runner; GitHub fails a job queued for an unavailable self-hosted runner after its queue timeout, then verify-hosted auto-runs and the gate takes it | Slow-path but self-healing; short window (60 s cadence + hysteresis + EXIT trap) makes this rare. Manual fast path: cancel the run / `gh run rerun` |
| verify-self flakes (macOS-only failure) | Exactly one automatic hosted re-run; gate takes the hosted PASS with a disagreement annotation | Check verify-self logs for the flake; no merge impact |
| verify-self passes but macOS masked a Linux-only failure | Possible in theory (self PASS stands per owner decision) | Nightly hosted canary on main catches Linux-only breakage within 24 h; `smoke` (hosted Playwright) still runs on every PR as an independent hosted build signal |
| Corrupt/garbage variable value | jq parse fails → hosted | Publisher's next cycle overwrites |
| Clock skew (future ts) | Negative age treated as stale → hosted | Self-corrects when clocks agree |
| Actions spending limit $0 | Hosted jobs (classify/gate/verify-hosted) fail — same exposure as before this PR; the self lane cannot save the gate because the gate job itself is hosted | Raise the spending limit (pre-existing constraint, unchanged by this PR) |
| Fork PR | Router refuses self; both lanes also carry the untrusted-source guard; repo is private (verified `visibility=private`) | Hosted path with the existing guard, unchanged |

## Minutes impact

- When the Mac advertises capacity: the ~4-6 min suite runs on the Mac at $0 hosted-minute
  cost; hosted spend for such a run is only classify (~10 s) + gate (~10 s) — billed as 2 min
  due to per-job rounding, vs ~5-6 min for a hosted suite run. Net ~60-70% hosted-minute
  reduction on self-routed runs.
- When the Mac is busy/asleep: identical to pre-PR behavior plus the gate job (~1 billed min).
- Docs-only PRs: unchanged from #370 (~2 billed min: classify + gate short-circuit).
- Nightly canary: ~5-6 hosted min/night (~165/mo) — the price of the continuous Linux baseline;
  it also refreshes the Linux `.next` cache.

## Files touched

- `.github/workflows/ci.yml` — restructure described above.
- `scripts/runner-availability.sh` — new, owner-run Mac-side publisher (ASCII-only, bash-3.2
  safe).
- `docs/rollouts/2026-07-04-ci-hybrid-runner-verify.md` — this note.
- `STATUS.md` — prepended entry.
- `docs/EFFORT-LOG.md` + `/Users/jay/apps/TRADING-EFFORT-LOG.md` — row moved Planned → In
  Progress → (Completed on merge).
- Repo variable `VERIFY_RUNNER_STATE` created via API with safe default
  `{"mode":"hosted","ts":0}` (settings change, not a file).

Explicitly NOT in scope (unchanged): `e2e.yml` (`smoke`), `security.yml` (`gitleaks`),
`shared-package-pin-check.yml` (`check-pin`) — all stay hosted per the owner's spec;
`cleanup-caches.yml` continues to cover the macOS cache lineage automatically (its grouping is
per key-prefix per ref, and the macOS lineage is just another prefix). The cross-repo
`workflow_call` reusable gate remains deferred until this PR proves itself; hosted-only default
stands when it is eventually built, with resource-aware routing as explicit per-repo opt-in.

## Verification

- `npx yaml-lint .github/workflows/ci.yml` — valid.
- `bash -n` and `/bin/bash -n` (Apple 3.2.57) on `scripts/runner-availability.sh` — clean;
  `grep -nP '[^\x00-\x7F]'` — pure ASCII.
- Route logic exercised standalone against 8 state shapes (absent var, hosted default, fresh
  self, stale self, fresh-self-but-merge_group, fresh-self-but-schedule, corrupt JSON, future
  ts) — every non-happy path routes hosted.
- Availability probes exercised read-only on the actual production Mac: ncpu/loadavg parse OK,
  vm_stat free+inactive parse OK, runner process detected alive, pm2 `trading` parsed online.
  Live validation of the premise: at test time the Mac was genuinely busy (load 13.9/10 cores,
  3.2 GB free+inactive — an agent build was running) and the formula correctly said "hosted".
- `VERIFY_RUNNER_STATE` created and read back via API.
- Full local quartet: `npm run lint` (0 errors), `npx tsc --noEmit` (clean), `npm test`
  (2436/2436), `npm run build` (green) — commands run in this worktree on this branch.
- Post-merge watch plan: first PR after merge shows route=hosted (publisher not yet started);
  after owner activation, watch one self-routed run's gate annotation and one forced-busy
  fallback.

## Follow-ups

- Owner: start the publisher (`pm2 start ... runner-availability`) when ready to activate;
  also add the pm2 one-liner to `~/apps/README.md` on the deployment machine (host-local ops
  doc — outside this repo).
- After a week of hybrid operation, compare hosted-minutes burn (Actions usage API) against the
  #370 baseline and record the measured split (self-routed vs hosted-routed run counts).
- The cross-repo reusable `workflow_call` gate (deferred): hosted-only default, routing opt-in.

## 2026-07-04 addendum — landing operator merge-forward + re-verify

PR #372 had drifted behind `main` (GitHub reported `mergeStateStatus: DIRTY` /
`mergeable: CONFLICTING`) after several other cars (#433, #436, #437, #365, and the W1/W2
learning-loop and effort-issues-mirror work) landed on top of the #370 base this branch forked
from. Re-fetched `origin` and ran `git merge origin/main --no-edit` in this worktree
(`~/apps/trading-wt-ci-efficiency`) — merged clean via the `ort` strategy with **zero textual
conflicts** (`STATUS.md` and `docs/EFFORT-LOG.md` both auto-merged; no `db.ts`/`strategy.ts`
overlap since this branch only touches CI/workflow files). Merge commit `1047c337` on top of
main tip `57a575f7` (#437).

Re-ran the full local quartet post-merge in this worktree:
- `npm run lint` — 0 errors (308 pre-existing warnings, unrelated backlog).
- `npx tsc --noEmit` — clean.
- `npm test` — 251 files / 2449 tests passed (test count grew from 2436 due to merged-in W1/W2
  learning-loop and episodic-retrieval test files; deleted stale gitignored `data/app.db` first).
- `npm run build` — green.

No follow-up beyond the items above; landing via `scripts/land.sh` next.
