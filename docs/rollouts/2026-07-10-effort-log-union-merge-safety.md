# 2026-07-10 — Effort-log union-merge safety net (fleet-infra)

## Summary

Adds `scripts/effort-log-union-merge.py`: a row-level, invariant-checked merge tool
that reconciles the machine-local live effort board (`/Users/jay/apps/<APP>-EFFORT-LOG.md`)
against the repo-tracked mirror (`docs/EFFORT-LOG.md`) **without ever dropping a row that
exists only on the live board**.

## Why

A fleet coordination note (`codex-automerge-race-and-board-clobber` memory) reported: "A
merge-shepherd launchd job (every 30 min, MONET-built 2026-07-09, digest in tracking issue
#1214) union-merges `/Users/jay/apps/TRADING-EFFORT-LOG.md` with the repo mirror — and rows
that exist ONLY on the live board get deleted (observed: a pickup claim row added 17:35 was
gone by 18:22)."

**Investigation finding:** an exhaustive search of every candidate location — the
`com.jay.merge-shepherd` launchd plist, `~/.claude-merge-shepherd/{run.sh,merge-shepherd.sh}`
(the actual host-side driver), the in-repo `scripts/merge-shepherd.sh` (all three copies —
this repo, `trading-monet-rh-harden`, `trading-monet-llmusage` — are functionally identical
modulo unrelated round-3 review fixes), every `/Users/jay/apps/*.sh`, every worktree's
`scripts/` directory, `.zsh_history`/`.bash_history`, and the `FLEET-INFRA-EFFORT-LOG.md`
board itself — found **no code that touches `/Users/jay/apps/TRADING-EFFORT-LOG.md`
programmatically at all**. `merge-shepherd.sh` only calls the GitHub API (`gh pr
merge`/`update-branch`/`comment`); it never reads or writes the Mac filesystem outside its
own log directory. The only real "union-merge" in the codebase is `docs/EFFORT-LOG.md
merge=union` in `.gitattributes` — git's built-in union driver, which only ever operates on
that one git-tracked file during a `git merge`, and only ever *adds* lines (it cannot delete
a row).

What most plausibly explains the observed row loss: an agent doing a board-conflict
resolution manually took **origin/main's mirror wholesale** as the reconciled content (an
already-documented pattern — see `docs/rollouts/2026-07-09-vitest-tmpdb-cleanup.md`: "To
avoid resurrecting stale duplicates via the union merge driver, the landing commit takes
`origin/main`'s board wholesale") and, at some point, that wholesale-mirror content was also
used to overwrite the *live* board — which silently drops any row an agent had added to the
live board but not yet mirrored into a commit. That is a manual/ad hoc failure mode, not a
scheduled job, but the fix is the same either way: a mechanical tool that performs the
"take the mirror, but never drop a live-only row" operation safely, so nobody has to get the
manual version right under time pressure again.

## What was built

`scripts/effort-log-union-merge.py` (stdlib-only Python, no third-party deps, matching the
existing `scripts/sync-effort-issues.py` convention):

- Parses both files with the same section/bullet model as `sync-effort-issues.py`
  (`## `-heading sections classified into `deployed`/`completed`/`in-progress`/`planned` by
  keyword; a top-level `- `/`* ` bullet starts an item; indented/blank lines fold into it).
- Item identity = SHA1 of the normalized first line — identical scheme to
  `sync-effort-issues.py`'s `effort-key`, so the two tools never disagree about row identity.
- **Output = the mirror's content verbatim, plus every live-only item appended into the end
  of its matching bucket section** (a new "(recovered by union-merge safety net)" section is
  created if that bucket has no existing section in the mirror at all). Items whose key is
  already in the mirror always take the mirror's text — "only rows present in a mirror may
  be updated from the mirror," per the fix requirement.
- **Hard invariant, enforced before AND after every write**: every item key present on the
  input live board must be present in the computed (and then actually-written) output. A
  violation aborts with no write and a non-zero exit rather than risk a silent drop — this
  is a mechanical guarantee, not just an intended behavior.
- `--dry-run` (default) reports what would be recovered and writes nothing. `--apply`
  writes to `--out` (defaults to `--live`). The mirror path is **never written** — the
  tool's blast radius is exactly the file the historical bug corrupted.

This tool only ever needs to be invoked with Mac filesystem access (it takes explicit
`--live`/`--mirror` paths), so — like `sync-effort-issues.py` explains for the reverse
direction — it is not wired into GitHub Actions; it's meant to run host-side (e.g. from the
`~/.claude-merge-shepherd` driver, or ad hoc before a manual board reconciliation). Wiring
it into the always-on 30-minute launchd job is a follow-up, deliberately left out of this
change: that job lives outside this repo (`~/.claude-merge-shepherd/run.sh`,
`~/Library/LaunchAgents/com.jay.merge-shepherd.plist`) and touching the always-running
fleet-coordination cron is out of scope for a repo PR under a "no deploys" constraint.

## Verification

All testing was done against **copies in a scratch directory**; the real live board
(`/Users/jay/apps/TRADING-EFFORT-LOG.md`) and the mirror were only ever read, never written
(md5-verified unchanged before/after every test run below).

- `python3 -m py_compile scripts/effort-log-union-merge.py` — clean.
- `npx tsc --noEmit` (node@24) — clean (no TS files touched).
- **Real-data dry-run**: copied the live board (1724 lines, 177 items) and mirror (2293
  lines, 208 items) to scratch; dry-run correctly identified 13 live-only rows (real,
  not-yet-mirrored claims — e.g. the MONET learning-review/vitest-cleanup/mistral-rebench
  in-progress rows) that would be recovered, and wrote nothing (verified via checksum).
- **Sentinel add/recover test**: added a synthetic `SENTINEL-TEST-ROW-UNION-MERGE-DRYRUN`
  row to the scratch live-board copy only (not in the mirror copy); `--apply` against a
  scratch `--out` recovered it (now 14 live-only rows) into the correct "In Progress"
  section, with correct blank-line spacing before the next heading; the mirror copy's
  checksum was unchanged (never written).
- **Idempotency test**: merging the mirror against itself as "live" produces byte-identical
  output (0 rows recovered).
- **Subset test**: a live board that's a strict subset of the mirror's rows produces output
  byte-identical to the mirror (0 rows recovered).
- **New-bucket test**: a live-only row in a bucket that has no section at all in the mirror
  gets a new `## <Bucket> (recovered by union-merge safety net)` section appended at the end
  of the document, rather than being dropped.
- **Invariant self-check test**: sabotaged a copy of the script so `recover_missing_items`
  became a no-op passthrough (simulating a latent bug), reran it — the post-computation
  invariant check correctly detected the missing live-only key, printed a
  `INVARIANT VIOLATION` error, exited 2, and **wrote no output file** (confirmed via `ls`).

## Files

- `scripts/effort-log-union-merge.py` (new)
- `docs/rollouts/2026-07-10-effort-log-union-merge-safety.md` (this file)
- `docs/EFFORT-LOG.md`, `STATUS.md` — protocol-required updates

## Follow-ups

- Wire `scripts/effort-log-union-merge.py` into the host-side merge-shepherd driver
  (`~/.claude-merge-shepherd/run.sh`) so the live board is reconciled against the mirror
  automatically on the existing 30-minute cadence, once a human/owner-supervised session
  can touch that always-running Mac cron (outside this PR's scope).
- Consider also running it (dry-run first) any time an agent is about to do a manual
  "take the mirror wholesale" board-conflict resolution, instead of hand-copying content.
- The live board has some pre-existing formatting quirks independent of this fix (e.g. two
  bullet items concatenated onto one physical line with no bullet marker between them,
  around the "2-3 day activity audit" / duplicate `## Completed` and `## In Progress`
  section headings) — this tool faithfully preserves them rather than correcting them
  (out of scope; a markdown-lint pass on the board is a separate, optional effort).
