# 2026-09-01 - L1 boundary-trim hardening, multi-app support, and the CT wedge

## 1. Context & Objective

PR #3140 landed `scripts/litestream-l1-boundary-trim.py` as the repo mirror of the tool
installed on `fleet-hetzner-nbg1` at `/usr/local/sbin/litestream-l1-boundary-trim`, which
unwedges Litestream level-2 compaction by deleting L1 objects a full snapshot has already
superseded.  The review on that PR raised three real guard gaps.  All three were fixed, the
hardened tool was installed and exercised on the host, and this change syncs the repo copy
back to byte-identity and documents the new behaviour.

Investigating those gaps surfaced a second, larger finding: **Congress.Trade's L1 had never
been trimmed at all and its L2 was wedged exactly the way Socratic.Trade's was.**  The tool
is therefore now a fleet tool with an `--app` selector rather than a Socratic-only script.

## 2. Changes Made

The script is a verbatim copy of the installed host binary - the repo copy was regenerated
from `ssh root@100.69.77.26 'cat /usr/local/sbin/litestream-l1-boundary-trim'`, not
hand-edited, so the two cannot drift silently.

Behavioural changes relative to the version #3140 landed:

- **Multi-app.**  A new `--app {socratic,congress,usage-monitor}` argument replaces the
  hardcoded `BUCKET` / `PREFIX` module constants with a lookup table.  `socratic` remains
  the default, so existing invocations are unchanged.
- **Snapshot truncation guard.**  The run now aborts when the newest snapshot is under 50%
  of the *previous* snapshot's size.  The pre-existing 100 MB absolute floor could not
  reject a truncated ~4.5 GB snapshot, and the boundary is read from the object's filename,
  which looks authoritative regardless of content.
- **Kept-chain contiguity.**  The run now walks the *entire* retained set for internal txid
  gaps instead of only checking that the first kept object reaches the boundary, and aborts
  when gaps exist.  Twins (same `maxTXID`, different `minTXID`) are explicitly allowed.
  Level-2 compaction stays wedged on non-contiguous input no matter how much L1 is trimmed,
  so reporting success in that state is actively misleading.
- **Configurable freshness.**  `--max-snapshot-age-hours` (default 48) replaces the
  hardcoded 48h constant.  The scheduled units pass `6`, so a late or failed nightly
  snapshot aborts loudly instead of silently trimming to yesterday's boundary and no-op'ing.
- **Boundary-did-not-advance guard.**  The run aborts when nothing is superseded while L1
  still holds more than 200 objects.
- **Hard deletes.**  `--b2-hard-delete` is passed on every delete call.
- **Documented exit codes.**  0 ok/no-op, 1 delete failures, 2 no usable snapshot, 3 snapshot
  failed a safety guard, 4 would leave a restore hole, 5 kept chain has internal gaps, 6
  nothing superseded although L1 is large.

Files touched:

- `scripts/litestream-l1-boundary-trim.py` - resynced verbatim from the host (mode 755).
- `docs/litestream.md` - rewrote the boundary-trim section: `--app` table, the guard list
  with per-guard exit codes, an exit-code table, the hard-delete billing lesson, and the
  transient-unit arming pattern.  The old "Pre-flight before `--apply` - what the guards do
  NOT cover" subsection is gone because all three of its gaps are now enforced in code.
- `docs/rollouts/2026-09-01-l1-trim-hardening.md` - this note.
- `docs/EFFORT-LOG.md`, `STATUS.md` - board and snapshot.

## 3. Decisions & Trade-offs

**Hide markers are billed, so deletes must be hard deletes.**  Backblaze B2 is versioned; a
plain `rclone delete` writes a hide marker and leaves the prior version in place.  The object
stops being listed while its bytes stay billed until the bucket lifecycle reaper collects
them, roughly a day later.  A trim that "worked" therefore frees nothing on the invoice for
24 hours, which is indistinguishable from the trim having failed.  This was measured, not
inferred: fleet billed B2 storage read **199.59 GB** against a **126.49 GB** logical
footprint - a ~73 GB overhang of hidden-but-billed versions.  Any future B2 cleanup script
in this fleet must pass `--b2-hard-delete`.

**Contiguity is a hard abort (exit 5), not a warning.**  A trim cannot fix a hole - it only
deletes at or below the boundary and never creates one - so continuing would delete real
objects and still leave L2 wedged, burning the shared Backblaze allowance on every retry.
Reconciling a hole needs a human, so the tool refuses rather than doing partial work.

**Freshness is configurable rather than tightened globally.**  Dropping the default from 48h
would have been wrong for interactive use, where a human reads the printed `modtime` and
decides.  The value that actually matters is on the *unattended* path, so the scheduled units
pass `6` and the default stays permissive.

**Still deliberately not a permanent nightly timer.**  Trimming L1 below a snapshot reduces
sub-daily point-in-time granularity for the trimmed span to whatever L0 still covers.  The
app's configured 168h snapshot retention stays the authoritative retention policy, and this
tool must never quietly become a second, shorter one.

## 4. Verification State

Repo copy is byte-identical to the installed host tool:

```
sha256 (host /usr/local/sbin/litestream-l1-boundary-trim)
  71c14e0a2255934097f57e87b75bcb49728299bbe711d783d96dd6dda0ee668c
sha256 (repo scripts/litestream-l1-boundary-trim.py)
  71c14e0a2255934097f57e87b75bcb49728299bbe711d783d96dd6dda0ee668c
```

Both 8018 bytes, mode 755.

Repo gate, run in AGENTS.md order:

```bash
npm run lint       # PASS - 792 problems (0 errors, 792 warnings) - grandfathered backlog unchanged
npx tsc --noEmit   # PASS - clean
npm test           # PASS - 699 files passed / 1 skipped; 7692 tests passed / 51 skipped; 484s
npm run build      # PASS - clean
```

Run on Node 24 (`/opt/homebrew/opt/node@24/bin` first on `PATH`) - the Homebrew default is
Node 26, whose ABI mass-fails `better-sqlite3`.

The script is Python and is not compiled by any of the four; it was syntax-checked and
exercised on the host directly (`--app socratic` and `--app congress` dry runs, then a
`--app congress --apply` run).

### Congress.Trade: L1 had never been trimmed, and L2 was wedged the same way

Verified against B2 on 2026-09-01, from the `--app congress` run's own output:

- CT's fresh nightly snapshot `0000000000000001-000000000005b521.ltx` landed
  **2026-09-01T00:00:02Z**, 896,065,649 bytes, boundary `5b521`.  Size ratio against the
  previous snapshot (848,386,671 bytes) was 1.06 - the truncation guard passed cleanly.
- CT L1 held **2,413 objects**, of which **2,362 (24,593 MB) were superseded** by that
  snapshot, leaving **51 objects (12 MB)**.  The first kept object
  `000000000005b50c-000000000005b534.ltx` reaches the boundary, and the contiguity walk found
  no internal gaps.
- CT's **L2 level held ZERO objects** - the same wedge state Socratic.Trade was in.  ST's L2
  is also at zero, with L1 at 172 objects after its earlier heals.

That CT had accumulated 2,413 never-trimmed L1 objects while its L2 stayed empty is the
strongest evidence that this class of wedge is silent: L0/L1 replication and every health
probe stay green throughout, because nothing user-facing depends on L2 compaction completing.

**The CT trim was started tonight in `--apply` mode at 2026-09-01T04:38:20Z** (logging to
`/var/log/fleet-backup/l1-trim-congress-20260901.log`), and **all of its guards passed** -
the numbers above are that run's own output.  Its delete phase is reported honestly here
because it did **not** behave as expected:

- ~7 minutes into the delete loop, CT L1 was still at **2,413 objects** - zero observable
  deletions - and the first doomed object (`00000000000450f0-00000000000450f3.ltx`, 758 MiB)
  was still present.  Counting with `--b2-versions` gave the same 2,413, so no hide markers
  were being created either.
- The process was alive and cycling child `rclone` processes roughly every **8 seconds**, so
  it was not hung on one call.  At that rate 2,362 deletes is ~5 hours, and the loop's
  progress line only prints every 200 objects, so no progress line was due yet.
- A read-only `--dry-run` of the exact delete the script issues (`--include "/<name>"
  --b2-hard-delete`) matched the object correctly in ~1.4 s, so the **filter syntax is not
  the problem**.

Whether those calls are succeeding slowly or failing is **not currently determinable from
the log**, which is itself the finding: `rclone()` raises `RuntimeError` carrying only the
return code, the caller catches bare `Exception` and increments `failed` without logging
*which* object failed or *why*, and rclone's stderr is captured and discarded.  A run that
fails 100% of its deletes is therefore indistinguishable from a slow successful one until
the terminal `APPLIED ... deleted=N failed=M` line, hours later.  See Next Steps.

No claim is made here that CT's L1 has actually been reduced.  What is verified is the
guard-passing analysis (2,413 / 2,362 / 51 and the zero-object L2), not the deletion.

### Scheduled retries on the host

Six **transient** one-shot systemd units are armed for **2026-09-02** at **00:04 / 00:20 /
00:40 UTC**:

```
l1trim-st-0004  l1trim-st-0020  l1trim-st-0040   --app socratic
l1trim-ct-0004  l1trim-ct-0020  l1trim-ct-0040   --app congress
```

Each passes `--max-snapshot-age-hours 6 --apply`, so an attempt that fires before the nightly
snapshot has landed aborts with exit 3 and the next attempt picks it up once it does - two
retries of headroom for a late snapshot.  Verified armed via `systemctl list-timers`, and
verified transient via `FragmentPath=/run/systemd/transient/...` plus `Transient=yes`.

These **replace** the earlier single `l1-boundary-trim-oneshot` unit, which was stopped;
`systemctl show l1-boundary-trim-oneshot.service` now reports `LoadState=not-found`.

They are transient on purpose.  Transient units do not survive a reboot, so a forgotten heal
expires on its own instead of silently becoming a nightly retention policy - which, per the
trade-off above, it must never be.

## 5. Next Steps & Blockers

1. **Resolve the CT delete-phase question first - it gates everything else.**  Read
   `/var/log/fleet-backup/l1-trim-congress-20260901.log` for the terminal
   `APPLIED app=congress deleted=N failed=M` line and re-count CT L1.  If `failed` is large,
   the host `rclone` `[b2]` remote's application key most likely lacks `deleteFiles`, and the
   armed CT timers will fail the same way.  If `deleted` is large but the count did not move,
   the deletes are landing somewhere other than expected.  Either way, do not assume the
   armed timers will heal CT until one manual run is proven to remove objects.

2. **Give the delete loop real failure reporting (paired repo + host change).**  `rclone()`
   discards stderr and reports only a return code; the caller catches bare `Exception` and
   counts a failure without naming the object or the reason.  Add stderr to the raised error,
   log the first few failures at the point they happen, and abort early once the failure rate
   is obviously total instead of grinding through thousands of doomed calls.  This must be
   applied to `/usr/local/sbin/litestream-l1-boundary-trim` and the repo copy in the same
   change, to preserve byte-identity.

3. **After the 2026-09-02 00:04-00:40 UTC window, confirm L2 actually recovered.**  Exit 0
   means "objects were deleted", not "compaction recovered".  Check for
   `msg="compaction complete" ... level=2` and for the L2 object's `<min>` TXID advancing on
   both ST and CT.  If CT's L2 count is still zero afterwards, the wedge has a second cause.
4. **Re-check billed vs logical B2 storage in ~24h.**  The 199.59 GB / 126.49 GB gap should
   close once the lifecycle reaper collects the pre-`--b2-hard-delete` hide markers.  Bytes
   deleted by this tool from now on should not contribute a new overhang.
5. **Usage-Monitor has a table entry but has not been exercised.**  `--app usage-monitor`
   (`jays-usage-monitor-eu` / `api-usage-monitor/prod.db`) should get a dry run before anyone
   arms it, to confirm the prefix is right and its L1/L2 state.
6. **The timers are transient by design and expire on reboot.**  If the wedge recurs, arm a
   fresh set - do not convert these into an installed nightly timer.

Blocker: item 1.  Until a CT `--apply` run is shown to actually remove objects, the CT half
of the armed timers should be treated as unproven.

## 6. Zero-Code Findings

- **The delete loop is O(n^2) by construction and very slow at CT's scale.**  Each iteration
  shells out to `rclone delete <dir> --include /<name> --b2-hard-delete`, and rclone must
  list the *whole* directory to resolve the `--include` filter - so a 2,362-object trim
  performs 2,362 full listings of a 2,413-object directory.  Measured on the host: a
  `--dry-run` call takes ~1.4 s, while the real calls in the running trim cycle roughly every
  **8 s**, putting a full CT run in the multi-hour range.  Because the progress line prints
  only every 200 objects, an operator sees ~25 minutes of silence before the first one and
  should not read that as a hang.  A future revision should collect the doomed names into one
  `rclone delete --files-from` call, turning 2,362 listings into one.
- **A totally-failing run looks exactly like a slow-but-working one.**  Failure accounting is
  a bare counter (see Next Steps item 2), so the log gives an operator nothing to act on
  until the run ends.  Combined with the multi-hour runtime above, a misconfigured credential
  could burn most of a day before anyone could tell.  These two findings compound; fixing
  either one alone leaves the diagnosis expensive.
- The tool never touches L2/L3.  When the L2 object *itself* is poisoned rather than merely
  oversized, `scripts/litestream-l1-suffix-heal.py` is still the right instrument; the
  comparison table in `docs/litestream.md` covers the choice.
