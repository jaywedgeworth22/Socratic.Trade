# Current Status

## 2026-07-11 — Trading-framework doc + public /framework page + AI-scrape hardening (CLAUDE, branch `claude/trading-framework-docs-713061`)

Owner-requested framework explainer shipped three ways: (1) `docs/trading-framework.md` — net-new
framework-level map of the entire trading pipeline (8-stage summary, layer-by-layer detail, core
invariants, honest weaknesses; derived from an 11-subsystem parallel code-reading pass, not from
older docs; explicitly does not supersede strategic-framework/phase-7/single-adversary). (2) A
public human-eyes-only page at `socratictrade.com/framework` following the how-it-works pattern
with three themed SVG diagrams (pipeline loop, layer stack, learning flywheel). (3) Layered
anti-extraction hardening: the prose lives in a server-only module served by a gated content API
(custom header + same-origin fetch metadata + UA gate) so it never appears in HTML or client
chunks; UA blocklist enforced in the page, the API, robots.txt AI-crawler rules, noai/noindex/
TDMRep headers, no-store, sitemap exclusion, no inbound links; PLUS live Cloudflare zone edge
hardening (ai_bots_protection=block + a /framework* WAF UA rule — Bot Fight Mode deliberately NOT
enabled to protect webhook/ops traffic). Focused tests 9/9 green; tsc clean after npm ci (stale
shared-pkg pin); dev-server curl + browser verification done (found and fixed a
background-tab-stranding rAF bug in the client fetch gate). Full Node 24 gate + land.sh pending
the fleet gate window (CODEX app-wide-audit gate active at write time). Rollout:
`docs/rollouts/2026-07-11-framework-page.md`.

## 2026-07-11 — Truthful notification delivery status (CODEX, current-main replacement branch)
## What was just completed
- Fixed `web-sources-sec.test.ts` dynamic dating issue which was causing the 30-day cutoff to fail once the static `2026-06-12` date aged out.
- Fixed `order-replacement.test.ts` to expect `pending_cancel` logic.
- Fixed TS2345 in `congress-analytics.ts` where `null` symbols could cause crashes.
- Verified completion of P1 items: Roth IRA truncation token cap raised to 4000+, `tradeThesisTag` coalescing in DB queries, and reflection dedupe signatures scoped per account.
- Implemented and verified LLM Failover UI and architecture.

## What's blocking / unresolved
- Nothing. All P1 and P2 items specified in the current sprint are complete.

## Next Action
- Land changes to main via `land.sh`.
