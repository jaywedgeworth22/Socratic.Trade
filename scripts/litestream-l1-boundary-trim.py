#!/usr/bin/env python3
"""Trim Socratic.Trade Litestream L1 objects already superseded by the newest snapshot.

Litestream 0.5's level-2 compaction reads the WHOLE remaining L1 chain into one
output object.  When L2 stalls (B2 endpoint flake, a capped download, a killed
multipart), L1 keeps growing, so the next L2 attempt is an even larger upload --
a loop that never converges and re-burns the shared Backblaze daily download cap
on every retry.  Deleting L1 objects whose maxTXID is at or below the newest L9
snapshot's maxTXID is safe by construction: a full snapshot already contains
those transactions, so restore is snapshot + the remaining L1/L0 chain.

Run right AFTER the nightly snapshot lands (it advances the boundary), so the
next level-2 compaction has only minutes of L1 to fold in.

Deletes and listings are Backblaze Class A/C -- free, and NOT subject to the
Class B download cap, so this works even while downloads are capped.

Default is a dry run.  Pass --apply to delete.
"""
from __future__ import annotations

import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone

BUCKET = "jays-socratic-trade-eu"
PREFIX = "trading-live/app.db"
LTX_RE = re.compile(r"^([0-9a-f]{16})-([0-9a-f]{16})\.ltx$")
MAX_SNAPSHOT_AGE_HOURS = 48
MIN_SNAPSHOT_BYTES = 100 * 1024 * 1024
APPLY = "--apply" in sys.argv


def log(msg: str) -> None:
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print("[l1-boundary-trim] %s %s" % (stamp, msg), flush=True)


def rclone(args: list[str]) -> str:
    proc = subprocess.run(["rclone", *args], capture_output=True, text=True, timeout=300)
    if proc.returncode != 0:
        raise RuntimeError("rclone %s failed rc=%d" % (args[0], proc.returncode))
    return proc.stdout


def listing(level: str) -> list[tuple[str, int, str]]:
    """(name, size, modtime) for one level, via lsl (Class C)."""
    out = rclone(["lsl", "b2:%s/%s/%s/" % (BUCKET, PREFIX, level)])
    rows = []
    for line in out.splitlines():
        parts = line.split(None, 3)
        if len(parts) < 4:
            continue
        size, date, clock, name = int(parts[0]), parts[1], parts[2], parts[3].strip()
        rows.append((name, size, "%s %s" % (date, clock)))
    return rows


def max_txid(name: str) -> int | None:
    match = LTX_RE.match(name)
    return int(match.group(2), 16) if match else None


def min_txid(name: str) -> int | None:
    match = LTX_RE.match(name)
    return int(match.group(1), 16) if match else None


def main() -> int:
    log("mode=%s bucket=%s prefix=%s" % ("APPLY" if APPLY else "DRY-RUN", BUCKET, PREFIX))

    snaps = listing("0009")
    if not snaps:
        log("ABORT: no L9 snapshot found")
        return 2
    snaps_parsed = [(n, s, t, max_txid(n)) for (n, s, t) in snaps]
    snaps_parsed = [row for row in snaps_parsed if row[3] is not None]
    if not snaps_parsed:
        log("ABORT: no parseable L9 snapshot")
        return 2
    newest = max(snaps_parsed, key=lambda row: row[3])
    name, size, modtime, boundary = newest
    log("newest snapshot %s size=%d modtime=%s boundary=%x" % (name, size, modtime, boundary))

    if size < MIN_SNAPSHOT_BYTES:
        log("ABORT: newest snapshot is only %d bytes (< %d)" % (size, MIN_SNAPSHOT_BYTES))
        return 3
    try:
        snap_time = datetime.strptime(modtime.split(".")[0], "%Y-%m-%d %H:%M:%S").replace(
            tzinfo=timezone.utc
        )
        age = datetime.now(timezone.utc) - snap_time
        if age > timedelta(hours=MAX_SNAPSHOT_AGE_HOURS):
            log("ABORT: newest snapshot is %.1fh old (> %dh)" % (age.total_seconds() / 3600, MAX_SNAPSHOT_AGE_HOURS))
            return 3
        log("snapshot age %.1fh - ok" % (age.total_seconds() / 3600))
    except ValueError:
        log("ABORT: could not parse snapshot modtime %r" % modtime)
        return 3

    l1 = listing("0001")
    doomed, kept = [], []
    for nm, sz, _t in l1:
        mx = max_txid(nm)
        if mx is None:
            log("WARN: unparseable L1 name skipped: %s" % nm)
            continue
        (doomed if mx <= boundary else kept).append((nm, sz))

    log("L1 total=%d superseded=%d (%.0f MB) keep=%d (%.0f MB)"
        % (len(l1), len(doomed), sum(s for _, s in doomed) / 1e6,
           len(kept), sum(s for _, s in kept) / 1e6))

    if kept:
        first_keep = min(kept, key=lambda r: min_txid(r[0]) or 0)
        gap = (min_txid(first_keep[0]) or 0) > boundary + 1
        log("first kept %s%s" % (first_keep[0], " -- GAP ABOVE SNAPSHOT" if gap else " (chain intact)"))
        if gap:
            log("ABORT: deleting would leave a restore hole between the snapshot and the kept chain")
            return 4

    if not doomed:
        log("nothing superseded - no-op")
        return 0
    if not APPLY:
        log("DRY RUN - rerun with --apply to delete %d objects" % len(doomed))
        return 0

    deleted = failed = 0
    for nm, _sz in doomed:
        try:
            rclone(["delete", "b2:%s/%s/0001/" % (BUCKET, PREFIX), "--include", "/%s" % nm])
            deleted += 1
        except Exception:
            failed += 1
        if (deleted + failed) % 100 == 0:
            log("progress %d/%d" % (deleted + failed, len(doomed)))
    log("APPLIED deleted=%d failed=%d" % (deleted, failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
