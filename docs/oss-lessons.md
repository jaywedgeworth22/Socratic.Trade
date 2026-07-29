# OSS Lessons — external references mapped to this repo

Owner-directed (2026-07-29). Survey of open-source projects whose designs solve problems this
repo also has, with a concrete "what to steal / what we already have / what to avoid" mapping
per area. Sources are 2026 secondary write-ups plus repo READMEs; star counts and feature
claims should be re-verified before treating any project as a dependency. Nothing here imports
third-party code — Hivekeep is AGPL-3.0 (patterns only, no code), OpenClaw is MIT, freqtrade is
GPLv3 (patterns only), Lean is Apache-2.0, OpenBB is AGPL (patterns only).

## 1. Reference inventory

| Project | What it is | Primary lesson area |
|---|---|---|
| freqtrade/freqtrade (GPLv3) | Mature crypto trading bot | Order state machine, Protections framework, dry-run parity |
| QuantConnect/Lean (Apache-2.0) | Event-driven backtest/live engine | Backtest==live parity, per-brokerage order-type models |
| Alpaca OMS v2 write-up (Redpanda blog) | Broker's own order manager design | Sequential-per-account processing, WAL-replayable state |
| OpenBB (AGPL) | Financial data platform | Provider interface + per-field provenance ("standardizer" split) |
| TauricResearch/TradingAgents | Multi-agent LLM trading desk (LangGraph) | Graph orchestration, debate protocol, risk veto separate from conviction |
| virattt/ai-hedge-fund | Multi-persona agent simulator | Structured signals + confidence, agent-accuracy weighting (meta-learning) |
| NoFxAiOS/nofx | AI trading assistant | Consecutive-miss kill switch ("safety mode") |
| microsoft/qlib | Quant research platform | Point-in-time data, walk-forward evaluation |
| TraderHarness | LLM-agent backtest harness | PIT masking + entity/date anonymization, trajectory export |
| Jesse (jesse.trade) | Python trading framework | Rule-significance testing (is entry timing better than luck?) |
| OpenClaw (MIT) | Local-first always-on agent gateway | Heartbeat output contract, Task Brain unified ledger, tiered model routing, exec approvals |
| Hivekeep (ex-KinBot, AGPL-3.0) | SQLite/TypeScript agent platform | Cron journal, preview renderers for mutating ops, hybrid memory retrieval |
| Inalpha | Quant agent framework | "LLM has no direct order path — every order passes machine approval" |

## 2. Agent operations — OpenClaw / Hivekeep (FOUNDATION LANDED 2026-07-29)

**Already had:** durable leader lease (`scheduler-lease.ts`), boot autonomy interlock,
per-account cadence lanes, in-flight guards, Sentry cron check-in, `due_jobs` claimable queue.

**Stolen:**
- **Task Brain / cron journal (IMPLEMENTED — see §9).** OpenClaw's 2026.3 "Task Brain" and
  Hivekeep's `get_cron_journal` both unify every kind of scheduled/background fire into one
  inspectable ledger. Our state was spread across `internal_settings` markers, `strategy_runs`,
  `due_jobs`, and `audit_events` — you could not answer "what did the scheduler do in the last
  hour, lane by lane" from one place. New `task_journal` table + `task-journal.ts` + scheduler
  wiring + ops-snapshot exposure fixes that.
- **Heartbeat output contract (doc-level confirmation).** OpenClaw's heartbeat skill rules —
  strict "say nothing when nothing is actionable," cron for exact timing vs heartbeat for
  adaptive — validate the `eventRunMode` + `fallbackIntervalMinutes` design from
  `docs/event-driven-transition-plan.md`. No code change needed.
- **Model tiering review (§3 below).**

**Avoid:** OpenClaw's community skill-registry model (a real exfiltration/prompt-injection
incident occurred — relevant if strategy packs are ever community-sourced); single-gateway
SPOF (we already enforce one scheduler leader).

## 3. Model tiering — review (no code change recommended now)

Current state is already strong and goes beyond OpenClaw's pattern: role-tiered seats
(Green/Red/Coach with per-role model recommendations in `docs/manager-model-options.md`),
credential-aware rotation intersected with OpenRouter availability (`model-rotation.ts`),
provider cooldowns, daily budget + monthly spend ceiling with cadence rollback, and
mechanical-vs-reasoning separation (Nano-class for extraction/classification).

OpenClaw's one idea we do NOT yet have: **cost-tiered heartbeats** — cheap models for frequent
low-stakes cycles, frontier only for decisions. Our scheduler heartbeats are already LLM-free
(pure TS), so there is nothing to downgrade. The one candidate gap: if the trigger engine's
event triage ever uses an LLM per event, that triage should be pinned to a Nano-class seat, not
the Green seat. Flag for the event-driven transition; not worth code today.

## 4. Order lifecycle & broker sync — freqtrade / Lean / Alpaca OMS (PLANNED §7)

**Already had:** `isWorkingOrderState` shared terminal-state classifier (the 2026-07-27
`done_for_day` fix), `reconcilePendingFills` every tick independent of strategy cadence,
broker health gate suppressing runs on elevated `order_placement_uncertain`, in-flight guards
preventing double-sell on stale-exit cancel-replace, order_replacements ledger with
terminalization migration.

**Gaps worth stealing (freqtrade):**
- A single **order-state transition module** per broker adapter — freqtrade's core discipline
  is that *nothing outside the exchange wrapper interprets raw exchange status strings*. Our
  status interpretation is shared (`broker-side.ts`) but each adapter still maps raw statuses
  in its own way; a conformance test table (raw status → canonical state, per broker, incl.
  weird ones: `done_for_day`, `pending_cancel`, `replaced`, `expired`) would lock this down.
- **Protections framework shape**: freqtrade Protections are composable, per-pair/time-bounded
  cooldown objects evaluated pre-trade, each producing a receipt. Our guards (staleness gate,
  vol taper, heat taper, drawdown breaker) are close; adopting the uniform "protection →
  receipt" interface would make the Guardrails UI and risk receipts generic instead of
  per-guard bespoke.

**Gaps worth stealing (Lean):**
- **Brokerage models as data**: each broker's order-type constraints (e.g. Alpaca's
  "bracket orders must be entry orders" 422 that bit us on T sells) encoded declaratively and
  validated *before* submission, with unit tests per constraint — instead of learning each
  constraint from a production 422.
- **Backtest==live parity**: Lean's one engine runs both. Our `backtest.ts` is separate from
  the live path; full parity is a large effort, but the cheap first step is running the
  *policy/guard evaluation* (not the LLM) identically in backtest and live.

**Gaps worth stealing (Alpaca OMS write-up):**
- **Sequential-per-account ordering**: Alpaca's OMS processes each account's orders strictly
  sequentially because buying-power validation is order-dependent. Our per-account in-flight
  guards approximate this for specific lanes; a per-account execution mutex around ALL broker
  mutation lanes (strategy execution, stale-exit remediation, stop monitor, drain cancels)
  would make the invariant structural instead of per-lane.
- **WAL-replayable state**: OMS rebuilds state by replaying an event log. Our `fill_events` +
  `order_replacements` + `task_journal` (new) are close to a replayable log; documenting the
  reconstruction path (and a recovery drill) is the gap, not the data.

## 5. Preview renderers for mutating operations — Hivekeep (PLANNED, claimed KIMI)

Hivekeep renders a human-readable preview card for every mutating tool call (`update_memory`,
`delete_cron`, `update_secret`, …) before commit. We have this exactly once: the
trade-proposal approval card. Generalize:

- Define a `MutationPreview` contract: `{ title, diff: Array<{field, before, after}>, consequences: string[], confirmLabel, requiresTypedConfirmation }`.
- First candidates (non-trade mutations with real blast radius): policy/guardrail edits
  (Settings → Guardrails), account drain/purge, API-key deletion/tombstoning, learning-queue
  approve/reject, autonomy re-arm after boot-halt.
- Policy edits are the highest-value one: a "you are changing X from A to B; this affects
  account(s) …; last changed …" card would have made several past misconfigurations visible
  before save.
- Implementation sketch: server-side `buildMutationPreview(kind, before, after)` +
  one shared `<MutationPreviewCard>` component; wire per surface. Typed confirmation already
  exists for live-account dangerous actions — reuse that gate.

## 6. Backtest integrity for the learning loop — Jesse / TraderHarness / qlib (PLANNED)

The Phase 7 learning loop matures outcomes and (eventually) evaluates LLM proposals against
history. Three contamination traps, three references:

- **Jesse — rule significance**: before a thesis tag or signal is credited with predictive
  power, test whether the same entries at *random* times would have done as well (permutation /
  Monte-Carlo baseline). Steal: a `significance.ts` that reports "this rule beats luck at p<X"
  before the learning loop promotes a lesson. Cheap, high value.
- **TraderHarness — PIT masking for LLM evaluation**: an LLM asked to "decide" on 2024 data
  may simply remember 2024. Their fixes: point-in-time masking (only data available at T is in
  context), entity/date anonymization (symbol → random ticker, dates → relative offsets), and
  full decision-trajectory export. Steal all three before any LLM-in-the-loop historical
  evaluation; without them a "backtest" of an LLM strategy measures memorization.
- **qlib — walk-forward discipline**: train/score windows roll forward; nothing fitted on the
  full sample. Applies to auto-tune weights (`auto-tune-scheduler.ts`): confirm tuning windows
  never include the evaluation window, and add a walk-forward report when they do.

## 7. Brokerage-model order-state hardening (PLANNED — umbrella for §4 items)

Tracked as its own effort row: conformance status tables per broker, declarative order-type
constraint validation pre-submission, per-account broker-mutation mutex, freqtrade-style
uniform protection receipts. Targets the exact bug classes from 2026-07-27/28 (done_for_day
inflation, order_placement_uncertain storms, bracket-order 422s).

## 8. nofx-style consecutive-miss safety mode (PLANNED)

nofx tracks rolling prediction accuracy; after N consecutive misses (default 3) the system
closes/hedges, suppresses new signals, and goes observation-only until accuracy recovers. We
have drawdown-based breakers but nothing *accuracy*-based: a thesis regime can degrade long
before a 15% drawdown, especially with small positions.

Design sketch: per-account rolling window of matured proposal outcomes (we already persist
outcomes via `outcome-engine.ts`); when the last K matured proposals are all adverse AND the
rolling hit-rate drops below a floor, auto-transition the account to a `degraded` posture:
no new openings (close-only), a `risk_advisory` notification (channel exists), and automatic
recovery after M clean observations or owner re-arm. Guardrails UI surface + policy.tuning
fields, mirroring the 2026-07-28 guard enablement pattern.

## 9. Implementation status

| Item | State |
|---|---|
| Task brain / cron journal (`task_journal`, scheduler wiring, ops snapshot) | **Implemented 2026-07-29 (this change set)** |
| Model tiering review | Done — no change (§3) |
| Preview renderers for mutations | Planned (§5) |
| Backtest-integrity suite | Planned (§6) |
| Brokerage-model hardening | Planned (§7) |
| nofx safety mode | Planned (§8) |
| Graph flows | Existing `TradingGraph` orchestrator (strategy.ts) is the LangGraph-lesson landing spot; extend nodes there rather than adopting LangGraph |

## 10. Graph flows — note

The TradingAgents/LangGraph lesson landed before this doc: `runStrategyOnce` already runs as a
`TradingGraph` state machine (`src/lib/orchestration/trading-graph.ts`, nodes INIT →
DATA_GATHERING → ALTERNATIVE_DATA_ANALYSIS → FUNDAMENTAL_PROPOSING → RED_TEAM_REVIEW →
EXECUTION). Adopting LangGraph itself is not recommended (Python, heavy); the useful remaining
ideas are (a) node-level journaling — the new `task_journal` can carry graph-node timings via
its metadata — and (b) TradingAgents' "risk veto is structurally separate from conviction,"
which our policy layer already implements.
