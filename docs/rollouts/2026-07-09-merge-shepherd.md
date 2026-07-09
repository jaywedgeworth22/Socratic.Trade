# 2026-07-09 — Merge shepherd: auto-land completed background PRs

## Summary

Adds automation so completed background work stops silently rotting as stale open PRs:

1. **`.gitattributes`** — add `docs/EFFORT-LOG.md merge=union` (STATUS.md/PLAN.md already had it).
2. **`scripts/merge-shepherd.sh`** — drives auto-merge-armed PRs home + reports every open PR.
3. **`.github/workflows/merge-shepherd.yml`** — manual-dispatch trigger for the shepherd.
4. **launchd job** (`com.jay.merge-shepherd`, Mac fleet host, not in-repo) — the scheduled driver,
   every 30 min, using the host's `gh auth token` PAT.

## Why

Diagnosed root cause: the merge gate is lenient (ruleset requires only the `verify` check — no
approvals, not strict, no thread-resolution), yet green auto-merge-armed PRs sit for hours/days.
Cause: the handoff protocol makes **every** PR edit `docs/EFFORT-LOG.md` + `STATUS.md`, so each
merge turns every other open PR CONFLICTING. GitHub's native auto-merge can't self-heal a conflict,
and `land.sh` arms auto-merge once and never returns — so a PR that later conflicts (or whose `verify`
never dispatched) is stranded and forgotten. That is exactly the owner's report: "I think it was made,
but it went idle and forgotten."

Fix = remove the dominant conflict source (union-merge on the board file) + a shepherd that "comes
back": re-syncs stuck PRs (union-merge auto-resolves board conflicts on `update-branch`), re-runs
flaky `verify` once, merges the green ones, and publishes a digest.

## Behaviour / safety

- **Acts only on PRs the author already ARMED** auto-merge (i.e. went through `land.sh`). Everything
  else is reported, never force-merged.
- Green signal = the required `verify` check is SUCCESS. Uses attempt-and-react (the merge attempt
  itself resolves GitHub's lazy mergeability) rather than trusting the often-`UNKNOWN` mergeable flag.
- Merge-to-`main` is NOT deploy-to-prod (auto-deploy is OFF; prod is a separate ANNOUNCE-THEN-DEPLOY
  step) — so auto-landing to `main` keeps the human checkpoint at release time.
- Publishes an owner-facing digest to a single tracking issue ("Merge shepherd status") every run:
  merged / un-stuck / re-ran / real-conflict / verify-failing / not-armed / draft.
- Reversible: `launchctl bootout gui/$(id -u)/com.jay.merge-shepherd`.

## Files

- `.gitattributes`, `scripts/merge-shepherd.sh`, `.github/workflows/merge-shepherd.yml`
- launchd plist `~/Library/LaunchAgents/com.jay.merge-shepherd.plist` + script copy at
  `~/.claude-merge-shepherd/merge-shepherd.sh` (host-local, not in-repo — mirrors the disk janitor).

## Verification

- `bash -n scripts/merge-shepherd.sh` clean; `SHEPHERD_DRY_RUN=1` dry-run correctly classified the live
  backlog (3 would-merge green, 3 would-re-sync verify=NONE, 3 not-armed/parked, 1 draft).
- First supervised live run + launchd install recorded below / in STATUS.

## Follow-ups

- Optional: add a `SHEPHERD_TOKEN` PAT repo secret so the GitHub-Actions dispatch path can also
  re-trigger `verify` on re-synced PRs (the launchd driver already does, via the host PAT).
- The shepherd is per-repo; replicate the launchd job for Congress.Trade etc. if wanted.
