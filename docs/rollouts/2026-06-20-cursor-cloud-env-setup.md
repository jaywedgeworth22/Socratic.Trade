# 2026-06-20 — Cursor Cloud dev environment setup

## Summary

Set up and verified the development environment on the Cursor Cloud VM and
documented Cloud-specific run/verify notes in `AGENTS.md`. No application code
changed.

## Why

A Cloud agent needed a reproducible startup setup (dependency refresh + run/test
instructions) so future sessions can build, test, and run the dashboard without
re-deriving environment quirks.

## What was done

- `npm install` (684 packages, `better-sqlite3` from prebuilt binaries, 0 vulns).
- Verified the documented gate: `npx tsc --noEmit` (clean), `npm test`
  (38 files / 283 tests passing), `npm run build` (green).
- Ran `npm run dev` (Next.js on `http://127.0.0.1:3000`): root `200`,
  `/api/health` `{"ok":true}`, `/api/dashboard` and `/api/policy` return real
  Test-mode data.
- Hello-world action: through the UI, opened Settings → Operate and added `NVDA`
  to the Additional Watchlist; "Policy updated" toast confirmed and persistence
  verified via `GET /api/policy` (`additionalSymbols=["NVDA"]`).
- Added a `## Cursor Cloud specific instructions` section to `AGENTS.md`
  (also surfaced via the `CLAUDE.md` symlink).

## Files

- `AGENTS.md` (new Cursor Cloud section; `CLAUDE.md` is a symlink to it).
- `docs/rollouts/2026-06-20-cursor-cloud-env-setup.md` (this note).

## Verification

- `npx tsc --noEmit` — clean.
- `npm test` — 283 passed across 38 files.
- `npm run build` — succeeded.
- `npm run dev` — root/health/dashboard/policy all 200; UI watchlist edit
  persisted.

## Follow-ups / notes

- `npm run lint` is interactive (no committed ESLint config); `tsc` is the gate.
- Startup update script for Cloud: `npm install`.
- The PM2/worktree multi-agent section in `AGENTS.md` is the author's deployment
  machine, not the Cloud VM.
