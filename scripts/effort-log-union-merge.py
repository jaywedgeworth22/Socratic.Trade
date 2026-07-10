#!/usr/bin/env python3
"""
effort-log-union-merge.py — safely reconcile the machine-local live effort
board (`/Users/jay/apps/<APP>-EFFORT-LOG.md`) against the repo-tracked mirror
(`docs/EFFORT-LOG.md`), WITHOUT ever dropping a row that exists only on the
live board.

Why this exists
----------------
Per `docs/EFFORT-LOG-PROTOCOL.md`, the live board is updated FIRST and is the
real-time source of truth; the repo mirror is updated at every commit/push and
lags the live board between landings. Any process that reconciles the two by
taking the mirror's content "wholesale" (a pattern already used ad hoc when
resolving `docs/EFFORT-LOG.md`'s `merge=union` git-attribute conflicts, see
`docs/rollouts/2026-07-09-vitest-tmpdb-cleanup.md`) silently deletes any row
an agent added to the live board that hasn't been mirrored into a commit yet
— observed 2026-07-09: a pickup claim row added 17:35 was gone from the live
board by 18:22 (see the "Live-board union-merge clobber" fleet coordination
note). This script is the safe version of that reconciliation.

Algorithm (deliberately asymmetric — mirror is the base, live is protected)
-----------------------------------------------------------------------------
1. Parse both files into board items (same section/bullet parsing model as
   `scripts/sync-effort-issues.py`): a top-level `- `/`* ` bullet starts an
   item, indented/blank continuation lines fold into it, a `## ` heading
   starts a new section classified into one of the four canonical buckets
   (deployed / completed / in-progress / planned) by keyword, or ignored
   (e.g. "Changelog", intro prose) if it matches none.
2. Each item's identity is a SHA1 hash of its normalized first line (bullet
   markers and markdown emphasis stripped, whitespace collapsed, lowercased)
   — identical scheme to `scripts/sync-effort-issues.py`'s `effort-key`, so a
   row's identity is stable across the two tools and across a state
   transition that doesn't reword the first line.
3. The output starts as the MIRROR's content verbatim (it is already a
   well-formed, protocol-maintained document — this mirrors how agents
   already resolve board conflicts by taking one side wholesale, see the
   rollout note above, except now it's mechanical and doesn't drop rows).
4. Every item whose key exists on the LIVE board but NOT anywhere in the
   MIRROR (i.e. a live-only, not-yet-mirrored row — exactly the case that
   was previously silently deleted) is appended verbatim to the END of its
   matching bucket section in the output. If that bucket has no existing
   section in the mirror (rare), a new section is appended at the end of the
   document.  Items whose key already exists in the mirror always take the
   MIRROR's text (the mirror is authoritative for anything it already
   tracks) — this is the "only rows present in a mirror may be updated from
   the mirror" half of the rule.
5. HARD INVARIANT, enforced before any write: every item key present on the
   input LIVE board must be present in the computed output. If this ever
   fails (a bug in this script, or a live-board item with an unparseable
   heading context) the script aborts with a non-zero exit and writes
   nothing, rather than risk silently dropping a row the way the bug being
   fixed did.

This script only ever WRITES the `--out` target (default: the live board
path). It never mutates `docs/EFFORT-LOG.md` — the mirror is only ever read.
That keeps this tool's blast radius to exactly the file the historical bug
corrupted.

Usage
-----
    python3 scripts/effort-log-union-merge.py \
        --live /Users/jay/apps/TRADING-EFFORT-LOG.md \
        --mirror docs/EFFORT-LOG.md \
        --dry-run

    python3 scripts/effort-log-union-merge.py \
        --live /Users/jay/apps/TRADING-EFFORT-LOG.md \
        --mirror docs/EFFORT-LOG.md \
        --apply

`--dry-run` (default) reports which live-only rows would be recovered and
which bucket they'd land in, and writes nothing. `--apply` performs the
write (to `--out`, default same path as `--live`) and re-verifies the
invariant against the file it just wrote. `--out PATH` lets tests point the
write at a scratch copy instead of the real live board.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
from dataclasses import dataclass, field

BULLET_RE = re.compile(r"^[-*]\s+(.*)$")
HEADING_RE = re.compile(r"^##\s+(.*)$")
PLACEHOLDER_RE = re.compile(
    r"^\(?\s*(none|n/?a\b.*|seeded empty.*|add rows here.*|record the.*|see rollout notes.*)\s*\)?\.?$",
    re.IGNORECASE,
)

# Keyword -> canonical bucket, checked in order (first match wins). Mirrors
# scripts/sync-effort-issues.py's classify_heading exactly so the two tools
# never disagree about which bucket a section belongs to.
SECTION_KEYWORDS = [
    ("deployed", "deployed"),
    ("completed", "completed"),
    ("in progress", "in-progress"),
    ("planned", "planned"),
    ("reserved", "planned"),
]

BUCKET_TITLES = {
    "deployed": "Deployed",
    "completed": "Completed",
    "in-progress": "In Progress",
    "planned": "Planned / Reserved",
}


def classify_heading(heading_text: str) -> str | None:
    lowered = heading_text.strip().lower()
    for keyword, bucket in SECTION_KEYWORDS:
        if keyword in lowered:
            return bucket
    return None


def normalized_key_text(first_line: str) -> str:
    text = re.sub(r"[*_`]", "", first_line)
    text = re.sub(r"\s+", " ", text).strip().lower()
    return text


def item_key(first_line: str) -> str:
    return hashlib.sha1(normalized_key_text(first_line).encode("utf-8")).hexdigest()


@dataclass
class Item:
    key: str
    bucket: str
    first_line: str
    # Raw source lines for this item, bullet through its last continuation
    # line, WITHOUT trailing blank lines. Reproduced verbatim on output.
    raw_lines: list[str] = field(default_factory=list)


@dataclass
class ParsedBoard:
    lines: list[str]  # original file, split on "\n", no line terminators
    items: dict[str, Item]  # key -> Item (first occurrence wins if duplicated)
    # For each bucket, the line index (into `lines`) one-past-the-end of the
    # LAST section in the document classified into that bucket, i.e. where a
    # new item should be inserted to land at the end of that bucket's most
    # recent occurrence. None if the bucket never appears.
    bucket_insert_at: dict[str, int]


def parse_board(text: str) -> ParsedBoard:
    lines = text.split("\n")
    items: dict[str, Item] = {}
    bucket_insert_at: dict[str, int] = {}

    current_bucket: str | None = None
    current_item: Item | None = None
    current_item_start: int | None = None

    def flush_item(end_idx: int) -> None:
        nonlocal current_item, current_item_start
        if current_item is None:
            return
        block = lines[current_item_start:end_idx]
        # Trim trailing blank lines from the captured block; separators are
        # re-inserted on output rather than preserved per-item.
        while block and block[-1].strip() == "":
            block.pop()
        current_item.raw_lines = block
        # First occurrence of a given key wins (defends against accidental
        # duplicate rows already in a file; doesn't try to be clever here).
        items.setdefault(current_item.key, current_item)
        current_item = None
        current_item_start = None

    for idx, raw_line in enumerate(lines):
        heading_match = HEADING_RE.match(raw_line)
        if heading_match:
            flush_item(idx)
            current_bucket = classify_heading(heading_match.group(1))
            continue

        if current_bucket is None:
            continue

        # Every non-heading line seen while inside a classified section is a
        # candidate insertion point for "end of this bucket's last section"
        # — updated on every line so it always lands just before the next
        # heading (or EOF) once the loop finishes this section.
        bucket_insert_at[current_bucket] = idx + 1

        bullet_match = BULLET_RE.match(raw_line)
        if bullet_match:
            flush_item(idx)
            content = bullet_match.group(1).strip()
            if PLACEHOLDER_RE.match(content):
                continue
            current_item = Item(key=item_key(content), bucket=current_bucket, first_line=content)
            current_item_start = idx
            continue

        # Continuation line: folds into the in-flight item implicitly via
        # flush_item's slice; nothing to do here beyond having updated
        # bucket_insert_at above.

    flush_item(len(lines))

    return ParsedBoard(lines=lines, items=items, bucket_insert_at=bucket_insert_at)


def recover_missing_items(mirror: ParsedBoard, live: ParsedBoard) -> tuple[list[str], list[tuple[str, str]]]:
    """Return (output_lines, recovered) where `recovered` is a list of
    (bucket, first_line) for every live-only item that got appended."""
    missing_keys = [k for k in live.items if k not in mirror.items]

    if not missing_keys:
        return list(mirror.lines), []

    # Group missing items by bucket, preserving their original relative
    # order from the live board.
    by_bucket: dict[str, list[Item]] = {}
    for key in missing_keys:
        item = live.items[key]
        by_bucket.setdefault(item.bucket, []).append(item)

    # Insert from the bottom of the document upward so earlier insertions
    # don't invalidate later insertion-point line indices.
    out_lines = list(mirror.lines)
    recovered: list[tuple[str, str]] = []

    insertions = []  # (insert_at, block_lines)
    trailer_sections: list[Item] = []  # buckets with no existing section in mirror

    for bucket, bucket_items in by_bucket.items():
        insert_at = mirror.bucket_insert_at.get(bucket)
        block: list[str] = []
        for item in bucket_items:
            block.append("")
            block.extend(item.raw_lines)
            recovered.append((bucket, item.first_line))
        # Preserve the document's blank-line-before-heading convention: if
        # what currently follows the insertion point is a non-blank line
        # (i.e. we're inserting directly above the next `## ` heading, with
        # no blank line in between), add one so the recovered block doesn't
        # fuse onto the following section header.
        if insert_at is not None and insert_at < len(mirror.lines) and mirror.lines[insert_at].strip() != "":
            block.append("")
        if insert_at is None:
            trailer_sections.append((bucket, block))
        else:
            insertions.append((insert_at, block))

    # Apply mid-document insertions in descending line-index order.
    for insert_at, block in sorted(insertions, key=lambda p: p[0], reverse=True):
        out_lines[insert_at:insert_at] = block

    # Append any buckets absent from the mirror entirely as new sections at
    # the end of the document.
    for bucket, block in trailer_sections:
        if out_lines and out_lines[-1].strip() != "":
            out_lines.append("")
        out_lines.append(f"## {BUCKET_TITLES.get(bucket, bucket)} (recovered by union-merge safety net)")
        out_lines.extend(block)

    return out_lines, recovered


def verify_invariant(live: ParsedBoard, output_text: str) -> list[str]:
    """Return the list of live-only-item keys still missing from
    `output_text` (empty list == invariant holds)."""
    output_items = parse_board(output_text).items
    return [key for key in live.items if key not in output_items]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--live", required=True, help="Path to the live board (read; recovery source).")
    parser.add_argument("--mirror", required=True, help="Path to the repo mirror docs/EFFORT-LOG.md (read-only base).")
    parser.add_argument("--out", default=None, help="Where to write the merged result. Defaults to --live.")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", default=True, help="Report only; write nothing (default).")
    mode.add_argument("--apply", action="store_true", help="Write the merged result to --out.")
    args = parser.parse_args()

    apply = args.apply
    out_path = args.out or args.live

    with open(args.live, "r", encoding="utf-8") as f:
        live_text = f.read()
    with open(args.mirror, "r", encoding="utf-8") as f:
        mirror_text = f.read()

    live = parse_board(live_text)
    mirror = parse_board(mirror_text)

    out_lines, recovered = recover_missing_items(mirror, live)
    output_text = "\n".join(out_lines)
    if not output_text.endswith("\n"):
        output_text += "\n"

    still_missing = verify_invariant(live, output_text)

    print(f"[union-merge] live items: {len(live.items)}  mirror items: {len(mirror.items)}")
    if recovered:
        print(f"[union-merge] {len(recovered)} live-only row(s) would be recovered into the output:")
        for bucket, first_line in recovered:
            preview = first_line if len(first_line) <= 100 else first_line[:97] + "..."
            print(f"  [{bucket}] {preview}")
    else:
        print("[union-merge] no live-only rows found -- mirror already a superset; output == mirror content.")

    if still_missing:
        print(f"[union-merge] INVARIANT VIOLATION: {len(still_missing)} live-only key(s) still missing from "
              "computed output -- refusing to write.", file=sys.stderr)
        for key in still_missing:
            print(f"  missing key: {key}  first_line={live.items[key].first_line!r}", file=sys.stderr)
        return 2

    if not apply:
        print(f"[union-merge] dry-run: would write {len(output_text.splitlines())} lines to {out_path} "
              "(pass --apply to write).")
        return 0

    with open(out_path, "w", encoding="utf-8") as f:
        f.write(output_text)

    # Re-verify against what actually landed on disk, not just the in-memory
    # string, as a final defense against any write-path surprise.
    with open(out_path, "r", encoding="utf-8") as f:
        written_text = f.read()
    post_write_missing = verify_invariant(live, written_text)
    if post_write_missing:
        print(f"[union-merge] POST-WRITE INVARIANT VIOLATION on {out_path} -- {len(post_write_missing)} "
              "live-only key(s) missing after write. This should be impossible; investigate immediately.",
              file=sys.stderr)
        return 3

    print(f"[union-merge] wrote {out_path} ({len(output_text.splitlines())} lines); "
          f"invariant verified post-write ({len(recovered)} row(s) recovered).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
