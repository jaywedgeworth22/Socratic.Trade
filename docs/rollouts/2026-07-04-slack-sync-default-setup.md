# 2026-07-04 — Slack coordination sync, on by default for all sessions/repos (Monet)

## Summary
Makes the two-Claude Slack coordination (Monet = cloud, Fable = local Mac) work
**by default in every Claude Code session and every repo**, without the flaky
Slack MCP connector. Ships a curl-based engine, a global `SessionStart` hook
installer, cloud wiring, and an owner/Fable guide.

Branch `claude/slack-sync-default-setup` (off `origin/main` @ `c2ee3f0`).

## What changed
- **`scripts/slack-sync.sh`** (new, engine) — MCP-independent Slack Web API wrapper.
  Subcommands `read` / `thread` / `post` / `reply` / `test` / `hook`. Safety model:
  - No `SLACK_BOT_TOKEN` -> every subcommand is a **silent no-op, exit 0** (the note
    goes to stderr, so the `hook` path injects *nothing* into a token-less session).
  - Token passed to `curl` via a `0600` temp `--config` file — never on `argv`
    (invisible to `ps`), never echoed/logged.
  - Fetched content wrapped in an `UNTRUSTED EXTERNAL DATA` envelope.
  - JSON via `jq` -> `python3` -> `sed/grep` fallback; pure ASCII (Mac bash 3.2).
  - `hook` subcommand: SessionStart context injection with a how-to header; it is
    **self-de-duplicating** per session (reads `session_id` from the hook's stdin
    JSON and claims a marker) so a global + repo hook can't double-inject.
- **`scripts/setup-slack-sync.sh`** (new, installer) — idempotent global install:
  copies the engine to `~/.claude/slack-sync.sh` and **merges** (never clobbers) a
  `SessionStart` hook into `~/.claude/settings.json` via a python3 JSON merge that
  preserves existing keys/hooks and upgrades the slack entry in place on re-run.
- **`scripts/cloud-setup.sh`** — now calls the installer (non-fatal) so any cloud
  environment pointed at it gets the hook automatically.
- **`docs/slack-coordination.md`** (new) — full setup: token as env secret (Mac
  export vs cloud Runtime Secret), install command, bot scopes
  (`channels:history` / `channels:read` / `chat:write`) + `/invite`, verify steps,
  everyday usage, and FAQ (incl. "renaming the channel is safe — calls key on the
  channel **ID** `C0BEZDJDNKV`, not the name").

## Why
The Slack MCP connector flapped, breaking coordination. A bot-token + curl wrapper
fired from a global `SessionStart` hook is reliable and dependency-free. `.claude/`
is intentionally git-ignored in this repo, so a committed per-repo hook is the wrong
vehicle *and* only covers one repo — the owner asked for **all** repos/sessions, so
the mechanism is a global `~/.claude/settings.json` hook (+ cloud setup step),
installed by a committed script.

## Verification
- `bash -n` clean on all three scripts; `grep -nP '[^\x00-\x7F]'` = pure ASCII;
  `$VAR`-adjacency check clean.
- `slack-sync.sh`: no-token `hook` prints nothing on stdout (exit 0), stderr note
  present; `help` works token-less; unknown subcommand exits 2. With a stubbed
  `curl`: `hook` injects header+envelope, a 2nd same-session run is silent (dedup),
  `read` shows the envelope, `post` returns ok.
- `setup-slack-sync.sh` in a sandbox `HOME`: merges the hook, **preserves** an
  unrelated `model` key, an unrelated SessionStart hook, and a `PreToolUse` hook;
  re-run leaves exactly **one** slack entry (idempotent).
- No TypeScript/app code changed, so the `verify` trio (tsc/test/build) is
  unaffected; `npx tsc --noEmit` run as a guard.

## Follow-ups / owner actions
- **Cloud env:** add `SLACK_BOT_TOKEN` as a **Runtime Secret**; point the env setup
  script at `bash scripts/cloud-setup.sh` (or add `bash scripts/setup-slack-sync.sh`).
  This cloud container currently has **no** `SLACK_BOT_TOKEN`, so Monet cannot post
  to Slack from here until that secret exists.
- **Local Mac (Fable):** `export SLACK_BOT_TOKEN=...` where Claude Code sees it, then
  `bash scripts/setup-slack-sync.sh` once. Both machines: `/invite` the bot + grant
  the three scopes.
- **Security:** any raw `xoxb`/`xoxp` token pasted into chat/files earlier must be
  **rotated** in Slack. Keep the token an env secret only — never committed.
