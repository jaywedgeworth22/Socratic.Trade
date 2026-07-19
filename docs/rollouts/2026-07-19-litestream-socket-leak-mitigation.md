# 2026-07-19 — litestream socket-leak mitigation (sync-interval throttle + region fix)

## Summary

Production deploys were wedged for hours: every Coolify deploy died at `git clone` with
`curl 18 transfer closed / fetch-pack: unexpected disconnect / fatal: early EOF`. Root cause
**proven by live measurement on the box**: litestream leaks ESTABLISHED sockets to the
Cloudflare R2 replica endpoint, exhausting kernel TCP memory, which clamps every connection's
receive window so bulk transfers to high-RTT hosts collapse. Full incident narrative and the
ruled-out alternatives are in `docs/rollouts/2026-07-19-deploy-wedge-diagnosis.md`.

## The measured leak signature

Every leaked fd is a socket to R2 (`172.64.0.0/13:443`), and they share one fingerprint:

- **100% `ESTABLISHED`** (822/822, later 1215/1215), timer `02` = `TCP_TIMER_KEEPOPEN`.
  Zero `CLOSE_WAIT`, zero `SYN_SENT`, zero orphans.
- **~80% carry a non-zero, FROZEN `Recv-Q`** (~34KB each). Two snapshots 45s apart joined by
  inode: of 2,707 surviving sockets, **2,704 unchanged, 0 shrank, 3 closed, 203 new**.
- **`bytes_sent: 2516` byte-identical on every socket**, `data_segs_out: 4`, `lastsnd`/`lastrcv`
  ~60s — one request per connection, response fully received, then abandoned forever.
- Only litestream leaks; the Next.js process sits flat at **30 fds**.
- Fires on **no-op ticks** (41 `ltx file uploaded` events vs ~2,700 leaked connections in
  10 minutes), so the rate tracks `sync-interval`, not write volume.

**Mechanism:** litestream's S3/R2 client opens a new TCP+TLS connection per request and
abandons the HTTP response without draining or closing it. The connection never returns to Go's
idle pool, is never closed by either side, and sits keepalive-pinned with its response bytes
stuck in the kernel receive queue.

## What this change does

1. **`sync-interval: 10s`** on the Coolify replica (previously unset → litestream's **1s**
   default). Leak rate is directly proportional to request rate: ~15k sockets/hr → ~1.5k/hr,
   moving time-to-TCP-pressure from ~5h to ~50h.
   **TRADEOFF: replica RPO 1s → 10s.** On catastrophic host loss, up to 10s of writes would be
   missing from the R2 replica instead of 1s (the local DB and LTX history are unaffected).
   **This is mitigation, not a fix — the leak still exists.**
2. **`region: auto`** (literal) in both `litestream.coolify.yml` and `litestream.yml`. The prior
   `${LITESTREAM_S3_REGION:-auto}` used bash default-expansion; litestream does its own `${VAR}`
   substitution and does **not** support `:-`, so it was resolving to an **empty** region —
   confirmed by the startup banner printing `region=""`. Latent misconfig, unrelated to the
   leak, fixed on its own merits.

## What this change deliberately does NOT do

The **code-level cause is still unproven**, and the leading hypothesis needs a test that
requires a container restart (an owner-chosen window), so no code fix is attempted here:

- **H-A (leading): HTTP/2 + GOAWAY retention.** litestream sets `ForceAttemptHTTP2: true` with
  no `ReadIdleTimeout`/`PingTimeout`; Go retains a `ClientConn` until all streams finish, and a
  stream whose body is never drained never finishes.
- **H-B:** un-drained bodies in litestream's own S3 read paths (upstream #1308). Weak: that's an
  error path, but this leak is systematic every tick.
- **H-C:** per-request client construction. Weakest, no code evidence.

**Discriminating test:** set `GODEBUG=http2client=0` on the container and re-measure fd growth
for 5 minutes — at ~4/sec the answer is unambiguous within 60 seconds. If the leak stops, the
durable fix is that one env var.

## Disproves the 2026-07-10 "durable fix"

`docs/rollouts/2026-07-10-deploy-blocker-tcpmem-litestream.md` blamed litestream **0.5.14** and
pinned back to **0.5.12** as the durable remedy. **That pin is running and it leaks anyway.**
The `Init()` HTTP-Transport block in `s3/replica_client.go` is **byte-identical across
v0.5.11 / v0.5.12 / v0.5.14** — only the retryer changed, never the connection-pool shape — and
**0.5.14 is HEAD**, so there is nothing newer to bump to. Version is a dead axis in both
directions. That note's own soak was recorded "Inconclusive-clean"; the pin was circumstantial.
**Do not re-apply version-pinning as the remedy.**

## Upstream correction owed

`benbjohnson/litestream` issue **#1354** (filed from this project on 2026-07-10) blames PRs
#1305 / #1326, both **0.5.14-only**. We leak on 0.5.12, which contains neither — the issue's
premise is falsified and should be updated with the socket-state evidence above.

## Files

- `litestream.coolify.yml` — `sync-interval: 10s`, `region: auto`.
- `litestream.yml` — `region: auto` (Mac lane, same latent misconfig).
- `docs/rollouts/2026-07-19-litestream-socket-leak-mitigation.md` — this note.
- `STATUS.md`, `docs/EFFORT-LOG.md` — ledger rows.

## Verification

Config-only; both files validated as parsing YAML with the intended values
(`region='auto'`, `sync-interval='10s'`). No application code touched, so the repo test suite is
unaffected — CI `verify` still gates the merge. Effectiveness must be confirmed **after deploy**
by watching `/proc/net/sockstat` TCP `mem` growth rate on the box (expect ~10x slower); a
watchdog alerts at 60% of the `net.ipv4.tcp_mem` ceiling.

## Follow-ups

- Run the `GODEBUG=http2client=0` test in an owner-chosen window; if it confirms H-A, ship the
  env var as the durable fix and open an upstream PR adding `ReadIdleTimeout`/`PingTimeout` and
  `MaxIdleConnsPerHost` to litestream's S3 transport.
- Correct upstream issue #1354.
- Consider a container memory limit so this can never again take the whole box toward OOM.
