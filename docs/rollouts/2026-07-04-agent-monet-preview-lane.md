# 2026-07-04 — Add the `agent/monet` preview lane + Cloudflare (Monet)

## Summary
Registers a fourth per-agent worktree/preview lane, **Monet**, analogous to the existing
`agent/claude` / `agent/codex` / `agent/antigravity` lanes, and wires its `monet.jays.services`
Cloudflare route. Branch `claude/register-monet-lane` (off `origin/main` @ `d8e1bdf`).

## Port: 4104 (not 4103)
Original plan was 4103, but a **read of the live tunnel config revealed `cursor.jays.services`
already maps to `localhost:4103`**. To avoid colliding with the Cursor lane, Monet uses the next
free port, **4104**. (Existing lanes 4100/4101/4102 are untouched.)

## What changed (repo)
- **`scripts/setup-agent-previews.sh`** — appended `monet` to `NAMES` and `4104` to `PORTS` (with a
  comment noting 4103 is Cursor's), plus the Monet header-comment line. The existing idempotent loop
  materializes the lane on the host: worktree `~/apps/trading-monet` on `agent/monet` (created from
  `origin/main` if absent), its own `node_modules`/`.env.local`, git hooks, PM2 `trading-monet` ->
  `next dev -p 4104`.
- **`scripts/sync-preview-lanes.sh`** — added the Monet lane (`agent/monet,agent/monet-*,monet/*`,
  `trading-monet`, port 4104) so the post-merge preview-freshness sync covers it.
- **`AGENTS.md`** — worktree table row (`trading-monet | agent/monet | 4104 | trading-monet |
  monet.jays.services`), the launch-dir list, and the preview-freshness site list all gain Monet.
- **`docs/deployment.md`** — Monet added to the preview-lane-sync list (`port 4104`, notes 4103 is
  Cursor).
- **`agent/monet` branch** — created on the remote from `main` (via the GitHub API; git-over-HTTP
  push was returning HTTP 503 at the time).

## What changed (Cloudflare, live)
Tunnel `6b807051-38ab-4062-8d52-0cddf1d66657` ("Jay's Home"), zone `jays.services`
(`98908d8b367f30b0694b29085df02229`), configured via the Cloudflare API with the env
`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`, mirroring the other agent lanes:
- **DNS:** created proxied `CNAME monet.jays.services -> 6b807051….cfargotunnel.com` (identical to
  claude/codex/antigravity).
- **Tunnel ingress:** inserted `monet.jays.services -> http://localhost:4104` before the catch-all,
  preserving every existing rule (the remote-managed config was read, the rule inserted, and PUT
  back whole). Verified: all 9 prior rules intact + the new Monet rule.

## Why
Owner request: make a new worktree/lane "formatted like `agent/monet`, analogous to `agent/claude`",
and "configure cloudflare right too." Monet is now a distinct fleet agent (cloud Claude) with its
own branch/port/preview/hostname.

## Verification
- `bash -n` clean on `setup-agent-previews.sh` + `sync-preview-lanes.sh`.
- Cloudflare API: CNAME create `success=true`; ingress PUT `success=true`; re-read confirms
  `monet.jays.services -> http://localhost:4104` present with all other rules intact.
- `agent/monet` confirmed on the remote.

## Follow-ups / owner
- **Owner does the one Cloudflare redirect rule** (dashboard-only) that the API path here does not
  cover.
- **Cursor/4103 discrepancy:** `AGENTS.md` says Cursor is not a dedicated port lane, yet the tunnel
  has `cursor.jays.services -> :4103`. Left as-is (not touched); flagged for the owner.
- Running `bash scripts/setup-agent-previews.sh` on the Mac materializes `~/apps/trading-monet` +
  the `trading-monet` PM2 preview on 4104. DNS may take a short while to propagate.
