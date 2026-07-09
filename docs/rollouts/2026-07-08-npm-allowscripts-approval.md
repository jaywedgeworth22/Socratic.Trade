# 2026-07-08 — npm `allowScripts` approval (deterministic native builds on npm 11)

## Summary

Added an `allowScripts` block to `package.json` approving the 7 packages that ship install
scripts — `@sentry/cli`, `better-sqlite3`, `fsevents` (x2), `sharp`, `esbuild`, `unrs-resolver` —
via `npm approve-scripts` against the current lockfile versions.

## Why

npm 11 gates package install scripts by default. Unapproved, `better-sqlite3`'s `node-gyp rebuild`
is skipped, so the native binding is never built and the app crash-loops at runtime on a missing
`better-sqlite3` native `.node` (the 2026-07-06 production incident). That was previously worked
around by hand-editing the host `~/.npmrc`, which was itself fragile — a stray `allow-scripts` line
there triggered `EALLOWSCRIPTS` and broke `npm ci` entirely. Declaring the approvals **in
`package.json`** makes the fix in-repo and portable: every install path (CI, Coolify, a fresh clone)
builds the native deps deterministically with no dependency on host `~/.npmrc` state.

## Files

- `package.json` — new `allowScripts` block (7 entries). No dependency changes; no `package-lock.json`
  change.

## Deliberately NOT included

This was extracted from a larger uncommitted change sitting in the integration worktree
(`~/Code/Socratic.Trade`) that also (a) added `@sentry/cloudflare` and (b) regenerated the entire
lockfile (~7.7k lines). Both were dropped:
- `@sentry/cloudflare` is the Sentry SDK for the **Cloudflare Workers** runtime — dead weight in this
  Next.js/Coolify **server** app (imported nowhere; Sentry here is already handled by `@sentry/nextjs`).
  It belongs in **Congress.Trade** (the actual Worker), not here.
- The lockfile regeneration was a drifted npm-version artifact (e.g. `esbuild` 0.23.1→0.28.1), unrelated
  to the `allowScripts` fix and not carried here.

## Verification

- `npm approve-scripts <pkgs>` → 7 approved; `npm approve-scripts --allow-scripts-pending` → "No
  packages with unreviewed install scripts."
- `npm ci` clean with the block; `better-sqlite3` native `.node` builds.
- verify gate (tsc / test / build) via `land.sh`.

## Follow-ups

- If Congress.Trade wants Sentry-on-Workers, add `@sentry/cloudflare` **there**.
