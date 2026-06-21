# 2026-06-20 — Retire `jaywedgeworth22/public` (Atlas) + port useful work into the private repo

Living note for the multi-step effort to salvage, port, and retire the public "Atlas" BFF repo
(`jaywedgeworth22/public`), which held work meant for this canonical private repo.

## Summary / decisions

A multi-agent inventory (14 agents) classified every Atlas subsystem against the private repo.
User decisions: **preserve AND port the useful bits into TS now**; **empty the public repo but keep
the shell**; **retire the live Atlas deployment** (after confirming the Cloudflare tunnel serves the
dashboard, not the BFF); **delete the redundant `~/agentic-trading` clone**.

Key discovery: `jaywedgeworth22/public` was not a dead repo — it was a **live, auto-deploying
deployment** on this Mac (`~/Code/trading`, launchd `com.jays.trading` BFF on :8787, a 5-min
`com.jays.trading.autoupdate` git-puller, a 30-min backup cron, behind the same
`trading.jays.services` Cloudflare tunnel as the private dashboard). The tunnel was confirmed to
serve the private dashboard on **:4000** (the BFF ran in full mock mode with zero request traffic;
no ESTABLISHED connections to :8787; private docs all point the tunnel at :4000).

## Salvage classification (verified against real code)

- **Already ported / superseded — dropped:** watchlist, alerts, orders/blotter, accounts/brokers,
  infra (auth/config/persistence/audit/market-data/types), vanilla-JS web frontend, deploy scripts,
  docs (byte-identical in `docs/atlas/`).
- **Useful — preserved + being ported to TS:** chat orchestrator (LLM tool-loop + draft-card +
  versioned safety prompt), RAG structure-aware chunking + `as_of` point-in-time filter, salience
  memory, transcript redaction store, no-execute golden eval gate, multi-channel alert delivery
  (notify), and two spec docs (account-naming, Atlas→Agentic merge checklist). The notify module +
  both specs existed only on unmerged branches.
- The inventory also found the integration map **overstated** RAG: storage (Pinecone/Voyage) is
  shipped, but chunking, hybrid retrieval, point-in-time filtering, and citation surfacing are NOT.

## Steps (chronological)

1. **Preserve (done):** complete `git bundle` of all 9 branches + PR refs → `reference/atlas-public-src/atlas-public.bundle`; useful source extracted alongside; `reference/atlas-public-src/README.md` documents provenance + the port plan.
2. **Delete redundant clone (done):** `rm -rf ~/agentic-trading` (verified clean duplicate of the private repo; worktrees intact).
3. **Retire deployment — safe half (done):** uninstalled `com.jays.trading.autoupdate`, removed the backup cron (both archived to `~/.atlas-retired/`).
4. **Retire deployment — BFF (done):** stopped + uninstalled `com.jays.trading` (mock-mode orphan, tunnel serves :4000). `~/Code/trading` checkout left on disk as instant rollback; bundle is the durable copy.
5. **Empty the public repo (pending):** delete the 8 non-`gh-pages` branches, wipe `gh-pages` to a tombstone README, keep the (empty) repo.
6. **Port useful subsystems to TS (pending):** see the table in `reference/atlas-public-src/README.md` and `docs/atlas-integration-map.md`.
7. **Fix `docs/atlas-integration-map.md` (pending):** correct the RAG overstatements; mark ported items.

## Files (so far)

- `reference/atlas-public-src/**` (new — archive bundle + extracted source + README)
- `docs/rollouts/2026-06-20-atlas-public-retire-and-port.md` (this note)

## Verification

- Bundle integrity: `git bundle list-heads` shows all 9 branches + PR refs.
- Tunnel: `lsof` — active connections on :4000, none on :8787; BFF log shows mock-mode + no traffic.
- Secret scan of public repo (all branches): clean — only `.env.example` placeholders.

## Follow-ups / risks

- Confirm `https://trading.jays.services` still loads the dashboard after the BFF stop (Cloudflare
  Access blocks automated checks). If anything is off, relaunch: the plist is in `~/.atlas-retired/`.
- After site confirmation, `rm -rf ~/Code/trading` for final cleanup.
- The TS ports are real feature work and land incrementally with the verify gate (tsc/test/build).
