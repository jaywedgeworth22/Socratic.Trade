# Effort Log — cross-agent board

The owner's at-a-glance ledger of every effort and its state. **Every agent on every platform
(Claude Code, Codex, Antigravity/Gemini, Cursor, web/cloud sessions) MUST keep this current** as
part of the Pre-Commit / Handoff Protocol in `AGENTS.md`. Move each row between the four states as
it changes; add new efforts as they are conceived; never delete another agent's row — correct it
in place and note the correction.

**State definitions**
- **Planned** — agreed/queued, not started. Include blockers (esp. "needs owner decision").
- **In Progress** — actively being built; carry a one-line status + the owning agent/branch.
- **Completed** — merged to `main`. This auto-deploys to **beta/integration only**
  (`trading-beta.jays.services`), NOT production.
- **Deployed to production** — the separate **owner-run** release step (`~/apps/trading-live`,
  pm2 `trading`, release branch). Cloud/agent sessions cannot perform or verify this — only move a
  row here when the owner (or a release runner) confirms the production deploy actually happened.

_As of 2026-07-03. PR numbers are GitHub `jaywedgeworth22/agentic-trading`._

---

## 🚀 Deployed to production

_Owner-managed release; not verifiable from cloud/agent sessions. When the owner promotes `main`
to `trading.jays.services`, record the release commit + date here._

- _(none recorded yet — awaiting owner confirmation of a production release)_

---

## ✅ Completed (merged to `main`, on beta/integration)

### Console parity port — legacy `app/ui/*` rebuilt as `/console` (2026-07-02)
- **#321** — parity-port foundation: logo/model/drilldown primitives, nav scaffolding, model-attribution approval card.
- **#322** — Settings expansions: brokers, API keys, LLM model picker, delivery channels, glossary.
- **#324** — Learned-context approval inbox on `/console/approvals`.
- **#325** — AI Assistant chat destination (`/console/assistant`) → staged proposals. _(incl. coordinator round-2 fixes: ref-during-render lint, image-exfil block, preview-race generation guard, frozen staged scope.)_
- **#326** — Macro & market-regime board (`/console/macro`) + honest no-FRED handling (`fredSourced`).
- **#327** — Scan destination: Market Scan table + Smart Money.
- **#328** — Orders destination: open orders, stale-limit detection, replace-at-market, cancel.
- **#329** — Parity tail: run-blocked routing, sign-out, allocation, watchlist+alerts, consent gate, sharing prefs, account deletion, admin links, badge fold-in.
- **#330** — Symbol drilldown superset of the legacy company drawer.

### Real-money / tax gate (2026-07-02)
- **#323** — Wash-sale handling modes (`block`/`ask`/`auto`) + Decide-mode escalation framework. _(incl. coordinator round-2: account tax-type precedence, in-run cap demotion, `transitionProposalIfPending` CAS.)_
- **#331** — IRA wash-sale disregard setting (`taxSettings.iraWashSaleHandling`), owner-requested. Default `block` (unchanged); `disregard` proceeds annotated ("Wash Sale (Technically, but IRA purchase unreported to IRS)") + audited. _(incl. coordinator Codex round-1: prompt threading via `isIraTaxRegime`, deferred disregard audit to execution, `decision.approved` gate.)_

### Backend follow-ups (2026-07-02, landed by parallel sessions)
- **#332** — `@sentry/nextjs` bump to ^10.63.0 + short/cover risk-path semantics clarification.
- **#333** — Chat idempotency: `clientTurnId` retry dedupe on `POST /api/chat` (migration v10).
- **#334** — Persist failover-aware `proposedByModel` per proposal; blank (never fabricate) no-FRED macro (`DEFAULT_MACRO`→`BLANK_MACRO`, `pruneMacro` drops `""`).
- **#335** — `EquityOrder` limit/stop/TIF through Alpaca+Robinhood mappers + `/console/orders` columns; disclosure-ordered congress cap; `MarketQuoteSummary` factor/headlines/volume fields; Turbopack dev fix.
- **#336** — `sources.price` provenance in `mergeQuoteData` (merged broker/Yahoo price now attributed to the merge provider, not the stale screener) + this cross-agent effort log.
- **#337** — Owner decisions record + `docs/manager-model-options.md` (cross-provider model comparison for the strategist role).

---

## 🔨 In Progress

- **De-paternalize: kill paper-as-default + Test mode** (coordinator, cloud) — owner directive
  (repeated/emphatic): real trading app, owner accepts 100% risk; stop treating paper as default and
  DELETE Test mode / the local simulator; don't protect the owner's money from agent bugs.
  **Step 1 (done, PR pending):** `AGENTS.md` — deleted the paper-default / `paperMode:false` Don't-rule
  + the "defaults to Test mode" framing; added a "Product philosophy — real trading, owner's risk"
  section (an account is an account; no local-sim; harden CORRECTNESS not OBEDIENCE; guardrails are the
  owner's overridable prefs). **Step 2 (in progress, separate PR):** remove the `test/local` /
  `usesLocalSimulation` execution path + `paperMode`-as-default across ~35 src + 36 test files
  (`execution-mode.ts` hub → strategy paper-fill branch, dashboard projection, defaults, tests). Land
  in coherent green pieces.

---

## ✅ Owner decisions (2026-07-03) — sovereign-design + housekeeping

1. **Drawdown circuit-breakers → HARD-HALT.** During the live soak, a drawdown breach halts autonomous
   trading until manually re-armed. _(Unblocks the hardening build.)_
2. **Stop-losses → PROMPT-EXPECTED.** The LLM proposes stops and policy validates; NOT schema-forced.
   _(Owner chose the more flexible option over the fail-closed default.)_
3. **Manager model tier → EVALUATE cross-provider, not a single pick.** Owner wants a list of options
   (incl. DeepSeek for cost) and to measure how each performs — see `docs/manager-model-options.md`.
   Recommended path: A/B Sonnet 5 / DeepSeek V4 Pro / GPT-5.5-or-Gemini-3.1-Pro in paper mode and rank
   by realized per-model P&L (now measurable via #334's `proposedByModel`). Budget: $25–200/mo covers a
   single model at ~20 runs/day; ~$300/mo covers a 3-model A/B.
4. **Draft #315 → CLOSED** (superseded by the console port).

---

## 📋 Planned

### Ready to build — decisions in
- **Live-execution hardening (next major build).** Now unblocked by decisions 1–2:
  - **Hard-halt drawdown circuit-breakers** — default-on during soak, halt autonomous trading on a
    drawdown-threshold breach until manually re-armed.
  - **Prompt-expected stop-losses** — strengthen the strategist prompt + schema to expect a stop on
    opening proposals, with policy validation (NOT a schema hard-requirement, per owner).
  - Build/test against a **connected broker account** (paper or live), NOT the removed local Test mode
    / `paperMode` default (see the In Progress removal above — that default is going away). Keep the
    existing typed-confirm ritual before any live toggle.
- **Manager-model A/B** — wire the shortlisted models via the OpenAI-compatible path (base-URL swap;
  DeepSeek/xAI/Qwen/Gemini) + the existing Anthropic path, run in paper mode, compare per-model Results.
  See `docs/manager-model-options.md`.

### Planned — actionable, not yet started
- **Per-model hit rates on Results** — now that `proposedByModel` persists (#334), surface realized
  win/return grouped by served model. _(Directly enables the Manager-model A/B above.)_
- **Per-field FRED sourcing** — a partially-failing FRED fetch still placeholder-fills individual
  series while the suite is flagged sourced; close with per-series flags (#326/#334 follow-up).
- **SSE for the learned-context inbox** — replace the 60s poll if the console gains an event stream.
- **`MarketQuoteSummary` factor bars for all scanned symbols** — #335 carried factor fields into the
  summary tier; confirm drilldown factor bars now populate for every scanned symbol, not just top candidates.

---

## Changelog of this log
- 2026-07-03 — Created (coordinator). Seeded from the 2026-07-02 landings (#321–#335) + the
  in-progress `sources.price` fix + blocked sovereign-design decisions.
- 2026-07-03 — #336 merged (→ Completed). Recorded the four owner decisions (drawdown=hard-halt,
  stops=prompt-expected, Manager=cross-provider A/B, #315 closed). Live-execution hardening moved
  Blocked → Ready. Added `docs/manager-model-options.md`.
- 2026-07-03 — #337 merged (→ Completed). In Progress now empty; next work is the Ready items
  (live-execution hardening + Manager-model A/B).
