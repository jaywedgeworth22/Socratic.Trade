# 2026-07-12 — shared-package-pin-check: resolve refs to commit SHAs before comparing

## Summary
Hardened `.github/workflows/shared-package-pin-check.yml` so it compares the two consumer
repos' `@jaywedgeworth22/congress-trading-shared` pins at the **commit** level instead of
the raw ref string. When the normalized ref strings differ but both specs are git-style
(`github:...#ref`, `git+...#ref`), the check now resolves each ref to a commit SHA against
`congress-trading-shared` (the shared package's own repo, which is public) via the GitHub
API before declaring a divergence — dereferencing annotated tags to the commit they point
at. A tag pin (`#v1.6.0`) and the equivalent raw-SHA pin (`#c4fcfb44...`) now compare EQUAL;
genuinely different commits still compare UNEQUAL and fail loudly. If exactly one side
resolves and the other errors, the check FAILS loudly rather than silently falling back to
a string compare that could be wrong. Only when NEITHER side resolves does it fall back to
the original normalized-string comparison (matches the pre-existing behavior for that edge
case).

## Why
This check false-failed every Socratic.Trade PR earlier today (2026-07-12) when
Congress.Trade re-pinned `congress-trading-shared` to a raw SHA that is exactly what tag
`v1.6.0` resolves to. The old check only did a normalized-string compare of the ref after
`#`, so `v1.6.0` (this repo) vs `c4fcfb4423a11318bda8486ecf3dd6ab1783e87a` (peer) read as a
divergence even though both consumers were on the identical commit. `main` self-healed by
moving this repo's own pin to the same raw-SHA form (see `package.json` /
`package-lock.json`), which made the string compare coincidentally pass again — but the
underlying bug was untouched and will recur the instant the two repos pin the same commit
via two different ref forms again. That is imminent: CODEX's pending `congress-trading-shared`
v1.7.0 bump uses the tag form (`#v1.7.0`), and if Socratic.Trade's side lags on a raw SHA (or
vice versa) the false-positive returns. This change makes the check correct by construction
instead of coincidentally-passing on today's specific pin state.

## Files
- `.github/workflows/shared-package-pin-check.yml` — added `is_git_spec`, `git_ref`,
  `parse_ref_json`, and `resolve_ref` shell functions plus the ref-resolution branch in the
  main comparison block; added `SHARED_REPO` env var (`jaywedgeworth22/congress-trading-shared`,
  the package's own public repo — distinct from `PEER_REPO`, which only hosts the peer
  consumer's `package.json`); updated the header comment block to describe the new
  resolve-before-compare behavior and the public-repo auth note.
- `docs/EFFORT-LOG.md` — new row.
- `STATUS.md` — new stanza.

## Verification
- `bash -n` on the extracted `run:` script block — syntax OK.
- ASCII-only check per AGENTS.md: `grep -nP '[^\x00-\x7F]' .github/workflows/shared-package-pin-check.yml`
  — no hits. Adjacency check (`\$\{?\w+\}?[^\x00-\x7F]`) — no hits.
- `actionlint` was not available in this environment; skipped per the task's "if available"
  caveat.
- **Replay-tested the compare logic against the live GitHub API** (shared repo is public, no
  token needed) by extracting the function definitions and the comparison block from the YAML
  into standalone scripts and sourcing them with hardcoded `LOCAL_SPEC`/`PEER_SPEC` values
  (bypassing the file-read/`gh api` peer-fetch steps, which aren't the code under test):
  - Case (a): `github:...#v1.6.0` vs `github:...#c4fcfb4423a11318bda8486ecf3dd6ab1783e87a`
    -> both resolved to `c4fcfb4423a11318bda8486ecf3dd6ab1783e87a` -> **OK, exit 0** (matches
    expected: tag == equivalent raw SHA).
  - Case (b): `github:...#v1.6.0` vs `github:...#6b37dd62dc71b38bcc5e333c82824bd2b609d79a`
    (the v1.7.0 SHA) -> resolved to `c4fcfb44...` vs `6b37dd62...` -> **::error:: DIVERGED,
    exit 1** (matches expected: genuinely different commits still fail).
  - Full output of both replays is in the PR discussion / session transcript; both matched the
    required outcomes exactly.
- Confirmed `package.json`'s own pin is unchanged (`github:jaywedgeworth22/congress-trading-shared#c4fcfb4423a11318bda8486ecf3dd6ab1783e87a`),
  so this PR's own required `check-pin` status (which — see Follow-ups — runs from `main`'s
  workflow definition on `pull_request` events, not this PR's) is unaffected by this change.
- Full verify gate run via `scripts/land.sh` (Node 24 PATH gate): `npx tsc --noEmit`,
  `npm test`, `npm run build` — see the landing commit's CI run for exact pass/fail; command
  outputs not duplicated here since `land.sh` re-runs them as part of the gate.

## Follow-ups / caveats
- **The required `check-pin` status that gates PR merges runs from `main`'s workflow
  definition on `pull_request` events, not the PR branch's** — a well-known GitHub Actions
  behavior for `pull_request`-triggered required checks. This means THIS PR's own `check-pin`
  run used the OLD (string-compare-only) logic, not the fix in this diff. Since `main` and
  this PR's `package.json` pin were identical and already in raw-SHA form, the old check
  passed anyway. The new ref-resolution logic only takes effect for PRs opened AFTER this
  change lands on `main`.
- No app code changed; this is CI-config only. `PLAN.md` was not touched (no scope/timeline/
  approach change to the product).
