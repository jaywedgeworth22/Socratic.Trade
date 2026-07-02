# TRADEDECK — An Operator-First Interface for the Agentic Trading Platform

*Blind bottom-up design from the capability inventory only. Lens: the multi-account power operator who runs several broker accounts daily, wants density, keyboard command surfaces, cross-account situational awareness, and zero ambiguity about which account and which money-reality any action targets.*

---

## 0. Design stance

Three facts from the inventory dominate every decision below:

1. **Money-reality is a derived, three-valued, word-labeled fact** (`test/local` = "Test", `broker/paper` = "Paper", `broker/live` = "Brokerage"), and every proposal, fill, snapshot, and run is stamped with it. The interface must make this fact *ambient* — visible without looking — not a badge you have to find.
2. **Every account is an independent machine**: its own policy, prompt, cadence, `systemState`, `strategyAuthority`, scheduler clock. The operator's core job is *fleet supervision*, not single-account babysitting. So the primary surface is a fleet console, not a portfolio page.
3. **The system already fails closed everywhere on the server.** The UI's job is not to add safety logic — it is to make the server's safety state *legible* (why is this blocked, what will happen if I click, what changed since I last looked) and to make the dangerous rituals (typed live approval, arming decide-authority) feel appropriately ceremonial without slowing down the 95% of actions that are Test/Paper.

The product name used throughout: **TradeDeck**. Accounts are "lanes." The operator drives from the "Fleet Console" and drills into a lane when something demands attention.

---

## 1. Information architecture and navigation model

### 1.1 Two axes: destination × scope

Navigation has two orthogonal dimensions the operator must always be able to read and set independently:

- **Destination** — *what kind of information* (monitoring, approvals, strategy config, analytics, ...). Left rail, number-key accessible.
- **Scope** — *which account(s)* the destination is showing. A persistent **Scope Bar** in the header: either `ALL LANES` (cross-account aggregate) or a single named lane (e.g. `Roth IRA — Alpaca — Brokerage`). Scope persists across destination switches. `Ctrl+1..9` jumps to a lane; `Ctrl+0` returns to ALL LANES.

This split is the core of the design: "Approvals" scoped to ALL LANES is a cross-account triage queue; scoped to one lane, it is that lane's queue. Same for Runs, Analytics, Risk. The operator never wonders "which account am I configuring" because scope is a first-class, always-visible header element that colors the entire frame (see §2).

### 1.2 Top-level destinations (left rail, top to bottom)

1. **Fleet** (`1`) — the home. One row per connected account: money-reality, `systemState`, `strategyAuthority`, equity + day P&L, open positions count, pending-approval backlog, next scheduled run countdown, last-run status, breaker/panic-brake indicators. Only available at ALL LANES scope; selecting a row scopes the app to that lane and drops you into its Lane Overview. *Why top-level:* cross-account situational awareness is the operator's first question every morning; nothing else can be the home.

2. **Approvals** (`2`) — the decision queue: every `proposed` trade across all lanes (or the scoped lane), plus queued risk-tier learned-context items awaiting approve/reject, plus tuning proposals awaiting apply. Badge count in the rail. *Why top-level:* it is the only place the human is load-bearing; it must be one keystroke away and impossible to miss.

3. **Runs** (`3`) — the run ledger and the Run Inspector: chronological `StrategyRunRow`s with per-run drill-in to candidates considered, signal snapshots, gate events, rationale-diversity flags, and counterfactuals. *Why top-level:* "why did the machine do that" is a daily audit job, not a settings page.

4. **Positions** (`4`) — positions, working orders, fills, brackets/synthetic-stop status per position, stale-limit alerts with one-action replace-with-market, cancel. At ALL LANES it is a cross-account blotter grouped by lane; symbol-level rollup shows aggregate exposure to a name across accounts (critical for the wash-sale story). *Why top-level:* order/position management is the operator's second-most-frequent surface.

5. **Strategy** (`5`) — per-lane strategy configuration: the prompt editor, scoring weights, policy editor (all ~50 fields, grouped), the Profiles library (create/apply presets), and the Tuning Workbench (autonomous tuning gates, shadow ledger, learning-mutation ledger with revert). Requires single-lane scope for editing; ALL LANES shows a comparison matrix (lane × key policy fields) for drift detection. *Why top-level:* it's a distinct mode of work (configuring, not supervising).

6. **Risk & Tax** (`6`) — the risk cockpit: live consumption gauges against every cap (daily notional used/limit, hourly, order count, gross/net exposure, sector, beta, correlation), circuit-breaker distance-to-trip, wash-sale locked symbols, tax lots (`daysToLongTerm` countdowns, `earlyExitTaxPremium`), harvest candidates, `TaxSummary`. *Why top-level:* limits are only useful if headroom is glanceable; burying this under Strategy would make caps invisible until they fire.*

7. **Analytics** (`7`) — performance: dual-bucket equity curves (live vs paper) vs SPY benchmark, run attribution, thesis/regime/sector scorecards, confidence calibration, factor IC, MAE/MFE, counterfactual "regret ledger" (skipped and rejected ideas with matured returns). *Why top-level:* the learning loop is a headline capability; the operator tunes based on this weekly.

8. **Market** (`8`) — the latest `MarketScan` per lane: ranked candidates with the 8-factor breakdown, per-field provenance, breadth, macro/regime panel (FRED series, VIX/VVIX/SKEW, panic-brake distance), watchlist, price alerts. *Why top-level:* it answers "what does the machine currently see," which the operator checks before second-guessing any proposal.

9. **Chat** (`9`) — the assistant, docked as a right-side drawer summonable from anywhere (`Ctrl+/`) rather than a full page; the full page exists for history review. Draft tickets from `draft_order` render inline with a "Promote to Proposal" action that visibly routes into the Approvals rail. *Why a drawer:* chat is a companion to other surfaces ("why did you buy NVDA" while looking at the fill), not a place you live.

10. **Ops** (`0`, admin-gated) — platform administration: users, LLM/RAG usage and cost ledgers, operator-funded spend, provider health (per service, per credential lane, consecutive-failure breakers), scheduler heartbeat, content pipelines (re-index filings, refresh web sources, securities import), tuning dry-run, factor-IC backtest, congress-gate evaluation, audit-event firehose, ops snapshot token. *Why top-level but last:* the deployment owner needs it daily-ish; tenants never see it.

**Settings** lives behind the avatar menu, not the rail — deliberately, because most consequential "settings" are actually per-lane policy (destination 5) and putting a generic Settings in the rail would create a second, ambiguous home for them (see §5).

### 1.3 The command palette: the real navigation

`Cmd+K` opens the **Command Line**, the keyboard-first spine. Its grammar is `[@lane] verb [args]`:

- `@roth halt` — set Roth lane `systemState: halted` (confirm dialog).
- `@all halt` — fleet-wide halt (typed confirm `HALT ALL`).
- `@alpaca-paper run once` — manual run (auto-forced to propose authority; the palette says so inline).
- `approve 3` / `reject 3 too crowded` — act on approval-queue item 3.
- `goto runs @robinhood-live` — scope + navigate.
- `alert AAPL < 200 "entry zone"` — create a `PriceAlert`.
- `watch NVDA @roth` — watchlist add.
- `find NVDA` — cross-account symbol search: positions, proposals, fills, lockouts, alerts for a symbol everywhere.

Every palette command shows a **preview line** before commit: the resolved lane, its money-reality word, and the server-side effect ("Roth IRA · Brokerage · systemState active → halted · no positions will be sold"). Commands that would touch `broker/live` capital render the preview in the live chrome (§2.2) and, where the server demands typed confirmation, embed the typed field right in the palette. The palette is a thin client over the same mobile-command catalog (`strategy.*`, `proposal.*`, `alert.*`, `policy.patch`...), so everything it can do is durable, idempotent, and audited.

---

## 2. Global frame and chrome

### 2.1 Frame anatomy

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ REALITY RAIL (4px, full height, left edge — color+texture of current scope)     │
│┌───────────────────────────────────────────────────────────────────────────────┐│
││ HEADER:  TRADEDECK   [SCOPE BAR: ● Roth IRA · Alpaca · BROKERAGE ▾]            ││
││          Mkt: OPEN 2:41 to close · Sched ♥ 12s · Regime: Late-Cycle Expansion  ││
││          [Approvals 4] [⚠ 1 breaker]                 [⏸ HALT LANE] [⏸⏸ HALT ALL]││
│├──────┬────────────────────────────────────────────────────────────────────────┤│
││ RAIL │  DESTINATION CONTENT                                    [Chat drawer ▸] ││
││ 1 Fl │                                                                        ││
││ 2 Ap │                                                                        ││
││ 3 Ru │                                                                        ││
││ ...  │                                                                        ││
│├──────┴────────────────────────────────────────────────────────────────────────┤│
││ STATUS STRIP: last SSE event · scan asOf 14:38 (3m) · quotes: delayed ·        ││
││ audit: #48211 policy.patch @roth 14:22 · boot: clean · [amber if interlocked]  ││
│└───────────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────────┘
```

Always visible, in priority order:

1. **The Reality Rail.** A full-height 4px band on the left edge plus a tint wash on the header, keyed to the scope's money-reality: **Test = slate/gray, solid**; **Paper = blue, solid**; **Brokerage = amber, diagonal-striped** (texture, not just color — survives screenshots, colorblindness, and dark/light themes). ALL LANES scope shows a segmented rail (one segment per lane, in fleet order) so a fleet view containing any live lane always carries visible amber stripes. The word label ("Test" / "Paper" / "Brokerage") always accompanies the color in the Scope Bar — word-first per the platform's own invariant.
2. **The Scope Bar**: lane label, broker, account number tail (`…4821`), money-reality word, and the lane's **Authority Ladder glyph** (§2.3). Clicking or `Ctrl+L` opens the lane switcher (typeahead).
3. **Clocks**: market session state and time-to-close/open; scheduler heartbeat age (turns amber >90s, red >3 min — the liveness canary); the current deterministic market regime label.
4. **Attention badges**: Approvals count; breaker/panic-brake indicator (which lane, which breaker); provider-degraded chip.
5. **Emergency controls** (§2.4): `HALT LANE` and `HALT ALL`, top-right, never scrolled away, never hidden behind a menu.
6. **Status strip** (bottom): freshest-data timestamps (scan `generatedAt`, quote delay disclosure), last audit event id + summary, SSE connection state, and the **boot-interlock banner** slot.

### 2.2 Live-context chrome

Whenever the focused object is `broker/live` — a live lane scoped, a live proposal card focused, a live command previewed in the palette — the surface acquires the **live treatment**: amber striped border, the word **BROKERAGE — REAL MONEY** in the object's header, and all primary action buttons rendered as *hold-shaped* (wider, labeled with the verb + the money: "Approve · ~$1,240.00 real"). Test/Paper objects get the plain treatment and lighter-weight confirms. The rule: **danger is styled at the object, not just the app** — a live proposal inside an ALL LANES queue is individually striped.

### 2.3 The Authority Ladder glyph

Each lane's operational state compresses into a 4-cell glyph read left-to-right, used in the Scope Bar, Fleet rows, and mobile:

```
[■][■][■][ ]   halted · close_only · active/propose · active/decide
```

- Filled up to the current rung; `halted` = one dark cell, `active`+`decide` = all four, with the fourth cell striped amber if the lane is Brokerage (armed autonomy on real money — the maximum-danger state, visually unique in the whole system).
- `close_only` set *by a breaker* renders its cell in red with a lightning tick; set by the human, plain.
- `liquidating` replaces the ladder with a distinct down-arrow glyph — it is not a rung, it is a wind-down.

The operator learns to read a fleet's danger posture in one saccade.

### 2.4 Emergency controls

- **HALT LANE**: one click → confirm sheet stating exactly what halting does and does not do: *"Freezes Roth IRA. No runs, no orders, no synthetic-stop exits, approvals refused. Nothing is sold."* The "nothing is sold" sentence is load-bearing — the inventory is emphatic that halting never liquidates, and operators under stress must not hesitate fearing a fire-sale. Confirm button: `HALT ROTH IRA`. No typed text — halting is the safe direction; friction is minimized.
- **HALT ALL**: same sheet, fleet-wide, typed `HALT ALL` (fleet-wide is big enough to deserve two seconds of typing, and it prevents a mis-click from freezing paper research lanes mid-experiment).
- Both also exist in the palette and on mobile (`strategy.stop`). **Un-halting is never on these buttons** — resuming goes through the arming flow (§4.2/§4.5 context), asymmetric by design: one key to stop, a ritual to start.
- A separate **CLOSE-ONLY** action lives on the lane header menu ("stop entering, keep protecting") with copy explaining synthetic stops keep running — this is what breakers set, and the operator can set it manually as a softer brake.
- **LIQUIDATE** is deliberately *not* adjacent to HALT: it lives at the bottom of the lane's Risk page behind a typed confirm (`LIQUIDATE <LABEL>`), because the inventory treats it as a deliberate human wind-down, and adjacency to panic buttons invites catastrophe.

---

## 3. Per-screen designs

### 3.1 First-run (empty state)

TradeDeck boots into the Fleet with one pre-provisioned lane: **Test Lab** (`broker:test`, always available, no credentials). The first-run takeover is a single dense checklist, not a wizard carousel — operators hate carousels:

```
┌ WELCOME — FLEET IS EMPTY EXCEPT THE SIMULATOR ─────────────────────────────┐
│ ▣ Test Lab lane created (local simulator, $10,000 simulated cash)          │
│ ▢ Pick a universe            → sp500 preselected; edit or accept           │
│ ▢ Review default guardrails  → $500/day, $X/order (5% NAV), stop 8%,       │
│                                take-profit 20%, 3 proposals/run  [View all]│
│ ▢ Add an LLM key             → required for proposal generation; without   │
│                                it: scans, watchlist, alerts still work     │
│ ▢ Run once (propose-only)    →  [▶ RUN ONCE — always human-approved]       │
│                                                                            │
│ Later: connect Alpaca (keys) or Robinhood (OAuth) · import a profile ·     │
│ set phone notifications                                                    │
│ Reality check: this lane is TEST — the app's own simulator, not any        │
│ broker's paper account. Nothing here can ever touch real capital.          │
└────────────────────────────────────────────────────────────────────────────┘
```

Design intents: (a) the first click that does anything is **Run Once**, which the server forces to propose authority — the user's first experience *is* the approval loop, teaching the core interaction on fake money; (b) the Test/Paper distinction clarification sentence appears verbatim at first contact; (c) defaults are shown as concrete dollars, not field names; (d) connecting a real broker is explicitly "later" — the inventory's philosophy (run Test indefinitely first) is encoded as sequence.

When a broker is first connected, the new lane arrives **halted**, with capabilities snapshot displayed ("shorting: not permitted by broker; options: level 0; agenticAllowed: yes") and a "This lane will do nothing until you arm it" banner.

### 3.2 Fleet Console (home / monitoring)

```
┌ FLEET ─ ALL LANES ──────────────────────────────────── as of 14:41:07 (SSE ●) ┐
│ LANE            REALITY    STATE▮▮▮▮  EQUITY     DAY P&L   POS  APPR  NEXT RUN │
│ Test Lab        TEST       ▮▮▮░ act/p  $11,204   +$86 0.8%   6    1    12m     │
│ Alpaca Paper    PAPER      ▮▮▮▮ act/D  $52,110   -$310 0.6%  11   —    3m      │
│ Taxable RH      BROKERAGE  ▮▮░░ c-only $18,432   -$402 2.1%  4    2    exits   │
│  └ ⚡ daily-loss breaker tripped 13:58 → close_only · [inspect] [re-arm]       │
│ Roth IRA        BROKERAGE  ▮░░░ halted $9,871    —          3    —    —        │
│  └ boot interlock: reverted to halted on restart 06:02 · [review & re-arm]    │
├────────────────────────────────────────────────────────────────────────────────┤
│ TAPE (all lanes, newest first)                       [filter: fills|blocks|…] │
│ 14:38 Alpaca Paper  FILL  buy 40 AMD @166.02 ($6,641) thesis:Momentum-Breakout│
│ 14:31 Taxable RH    BLOCK sell→ n/a  buy NVDA blocked: wash-sale lockout(9d)  │
│ 14:30 Taxable RH    RUN   #812 completed · 2 proposed · 1 blocked · [inspect] │
│ 13:58 Taxable RH    BRKR  maxDailyLossNotional breached → close_only · notify │
└────────────────────────────────────────────────────────────────────────────────┘
```

- **Rows are machines, not portfolios**: the columns the operator scans are state, backlog, and next-run — money second. Sub-rows surface *exceptional* conditions (breaker trips, interlock reverts, `placing_failed` needing reconciliation, `pending_reconciliation` fills, stale limit orders) as attached alerts with inline actions.
- **The Tape** is the cross-account event stream (SSE-fed): fills, blocks with their machine-readable reason, run completions, breaker events, withdrawn proposals, provider degradation. Every line links into the relevant inspector. Keyboard: `j/k` rows, `Enter` scope-in, `t` focus tape.
- ALL-LANES aggregates are explicitly bucketed: header shows "Live equity $28,303 · Paper+Test $63,314" — the design never sums real and simulated money into one number (mirrors the dual-bucket `FillSource` accounting).

### 3.3 Lane Overview (single-lane scope home)

Selecting a lane shows a two-column cockpit: left, the lane's state block (ladder, cadence and next-run clock, authority, breaker distances as small bullet gauges: drawdown 3.1%/8% max, daily loss $402/$500, hourly notional, daily orders 4/10); right, positions mini-blotter with per-position protection status (bracket resting at broker / synthetic trailing armed / Robinhood resting stop / UNPROTECTED in red), pending proposals, last run summary. Footer: this lane's tape. Everything links deeper; nothing requires a scroll on a 13" laptop.

### 3.4 Approvals (the decision queue)

```
┌ APPROVALS ─ ALL LANES ─ 4 pending ──────────── j/k move · a approve · r reject ┐
│ ① Taxable RH · BROKERAGE ⚠  BUY NVDA ~$1,240  conf 82  Momentum-Breakout      │
│    proposed 14:30 (11m) · expires in 47h · since-proposed: +0.4% ↗            │
│ ② Taxable RH · BROKERAGE ⚠  SELL 12 MRVL ~$820 Risk-Exit (take-profit band 1) │
│ ③ Test Lab   · TEST         BUY SOFI ~$400   conf 64  Value-Quality           │
│ ④ [CONTEXT] learned-context candidate (risk tier): "avoid earnings-week      │
│    entries on high-beta names" — origin: autonomous · [approve as advisory]   │
├─ DETAIL: ① ────────────────────────────────────────────────────────────────────┤
│ BUY NVDA — market, GFD, regular hours          reference $904.10 @14:30       │
│ Now: $907.72 (+0.40%) · drift 0.40% of 10% max · quote asOf 14:41 ✓fresh      │
│ Rationale: [full LLM rationale text…]                                         │
│ Thesis Momentum-Breakout (lane win-rate 61%, n=23) · Regime: Late-Cycle Exp.  │
│ Red Team: PASSED 14:30 ("bear case: crowded; countered by …")                 │
│ Revalidated 14:30: "setup intact" · Sizing: conviction 82 → 4.2% NAV, ADV ok  │
│ Gate preview (server, live): 14 checks pass · daily notional after: $2,061/…  │
│ Brackets: TP +20% trim 50% · SL -8% (broker-held)                             │
│ ┌ REAL MONEY — typed confirmation required ────────────────────────────────┐  │
│ │ estimated notional $1,240.00 · account …4821 · mode broker/live          │  │
│ │ Type to approve:  [ APPROVE LIVE NVDA__________ ]        [Approve] [Rej] │  │
│ └───────────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────────┘
```

Design decisions:

- **Triage list + focus detail**, fully keyboard-driven. `a` on Test/Paper approves after a light confirm; on Brokerage it focuses the typed field (typing is the confirm — no extra dialog). `r` opens a one-line reject reason (optional, feeds the record). `Enter` opens the full run context for the proposal.
- **The card is a diff, not a snapshot.** The detail pane foregrounds *what changed since proposal*: since-proposed %, current drift vs `maxEntryDriftPct`, latest `revalidationNote`, freshness of the quote, and the *live re-run of the gate preview* — because the server re-checks everything at approval time, the UI shows that same preview so approval never surprises ("will pass" / "will block: reason"). An approval that would fail shows the failure before the click.
- **Exits are visually prioritized** (Risk-Exit tags pinned to top with a shield icon): the system's philosophy is that exits are sacred; the queue sorts protection above speculation.
- Non-trade approvables (risk-tier learned context, tuning proposals) live in the same queue with clearly different card shapes — one inbox for "human is load-bearing," with copy stating exactly what approval does ("applies as advisory prompt text only; never changes any number").
- Expiry countdowns are visible; expired/withdrawn items collapse into a grayed "no longer actionable" band with their `revalidationNote` — the machine changing its mind is shown, not hidden.

### 3.5 Runs & the Run Inspector (decision forensics)

Runs list: dense table (id, lane, trigger interval/event/manual, status, duration, counts placed/paper/blocked/proposed, regime, rationale-diversity flag). The **Run Inspector** is the audit centerpiece:

```
┌ RUN #812 · Taxable RH · BROKERAGE · 14:29:41→14:30:22 (41s) · interval ───────┐
│ TIMELINE  lock → reconcile(0) → snapshot → breakers(ok, drawdown 3.1/8) →     │
│  hygiene(1 expired) → scan(512→38 scored, breadth 61%) → risk-exits(1) →      │
│  do-nothing gate(passed) → LLM propose(3) → sizing → red-team(1 reviewed,     │
│  1 passed) → corr-gate(1 skipped) → execute(1 proposed, 1 blocked) → snapshot │
├ CANDIDATES (chosen and skipped) ───────── sortable · columns = factor scores ─┤
│  SYM   SCORE  MOM  VAL  QUAL  SENT  …  DECISION       SINCE-DECISION          │
│  NVDA  0.81   0.9  0.4  0.7   0.8      PROPOSED       +0.4%                   │
│  AMD   0.77   0.8  0.5  0.6   0.7      SKIPPED (corr-cluster w/ NVDA)  +1.1%  │
│  PLTR  0.74   …                        SKIPPED (below cutoff)          -0.6%  │
│  [row expand → full CandidateEvidence: per-field values + provenance chips,   │
│   evidence bulletins, decision-time price, regime]                            │
├ GATE & BREAKER EVENTS ─ every reason string, verbatim ────────────────────────┤
│  BLOCK buy COIN: maxSymbolExposurePct would reach 27.4% > 25%                 │
├ ARTIFACTS: signal_snapshot ▸ · rationale-diversity: OK ▸ · summary text ▸     │
└────────────────────────────────────────────────────────────────────────────────┘
```

The **since-decision column on skipped rows** is the operator's counterfactual lens, live in the forensic view — the system scores what it didn't do, so the UI shows regret next to every skip reason. Every enriched value carries a hover **provenance chip** (`finnhub`, `yahoo-finance`, `robinhood-quotes`…, per the per-field `sources`), and absent data renders the honest `-` vs `n/a` distinction with a tooltip explaining which one it is.

### 3.6 Strategy (config workbench)

Single-lane scope; header repeats lane + reality prominently ("Editing: Taxable RH · BROKERAGE"). Four tabs:

- **Prompt** — full-width editor with the shipped default diffable ("Show diff vs default"), token count, and the output-contract reference pinned.
- **Policy** — the ~50 fields grouped exactly as the domain groups them (Run state & authority / Universe / Order-size caps / Exposure caps / Entry quality / Risk rules / Stops plumbing / Panic brake / Shorts / Sell-to-fund / LLM / Hygiene / Scan shape / Tax / Tuning). Each field: current value, default ghost-text, plain-language one-liner, and the *server clamp* shown where one exists ("hard max $100k"). A **"changed from default" filter** collapses the page to only deviations — the operator's drift check. Tuning knobs live behind an "Expert tuning (all default-off)" disclosure.
- **Profiles** — the library: cards with name, provenance, last-applied-to. Actions: `Apply to lane…` (picker defaults to *no* lane preselected — deliberate friction against fat-fingering the live lane) with a **pre-apply diff** (profile vs target lane, field by field) and the fixed reassurance line: "Applying never changes systemState — this cannot arm or disarm anything."
- **Tuning Workbench** — the learning-loop console: current scoring weights with per-factor realized IC sparkline; pending `StrategyTuningProposal` (summary, rationale, cautions, OOS gate verdict, clamped deltas visualized as ±0.05-capped bars); the **shadow ledger** as a would-have-applied timeline overlaying the equity curve; the `learning_mutations` ledger with one-action **Revert** per entry (restores the snapshotted prior state, confirm required).

Any policy edit on a **Brokerage** lane routes through the Blast Radius flow (§4.5).

### 3.7 Risk & Tax

Two stacked zones per lane (ALL LANES shows per-lane mini-panels plus the cross-account wash-sale board):

**Risk cockpit** — every cap as a horizontal consumption gauge (used / limit / headroom, red zone at 85%), grouped: today (daily notional, order count, hourly notional with its "breach auto-reverts to propose" warning printed on the gauge), portfolio (gross/net exposure, per-symbol top offenders vs `maxSymbolExposurePct`, sector caps as a bar-per-sector, beta, correlation), breakers (drawdown from high-water mark with the trip line drawn, daily loss, panic-brake panel showing live VIX/VVIX/SKEW vs thresholds). This page is where the operator *sees the cage*.

**Tax panel** — YTD `shortTermRealized`/`longTermRealized`, estimated liability, wash-sale events with disallowed dollars, **Locked symbols** board (symbol, lockout source lane, days remaining — shown cross-account because the lockout is cross-account), **Lots** table sorted by `daysToLongTerm` ascending with `earlyExitTaxPremium` in dollars ("selling AMD lot #3 today costs ~$41 extra tax vs waiting 9 days"), harvest candidates ranked. A toggle mirrors `subtractFromResults`. IRA lanes show the panel in a neutral "rates zeroed — IRA" mode rather than hiding it.

### 3.8 Analytics

Top: dual-bucket equity curves — **live bucket and paper bucket are separate charts, never overlaid on one axis** — each with the SPY buy-and-hold benchmark normalized to 100 and the excess-return figure; regions where data is insufficient render as gaps labeled "not computable," never interpolated. Below, a scorecard grid: Thesis × Regime heatmap (win rate, n, avg return — cells with n < threshold grayed "insufficient sample"), sector scorecard, confidence-calibration plot (stated confidence band vs realized win rate, with the diagonal drawn), factor IC table, MAE/MFE per thesis ("pain endured vs move captured"). A dedicated **Regret Ledger** tab lists rejected/blocked/skipped ideas with matured counterfactual returns, filterable by "you rejected" vs "machine skipped" vs "gate blocked" — the operator's mirror.

### 3.9 Market

Latest scan per lane: provenance header (`source` chain verbatim, `generatedAt` + age, scannedSymbols → returnedQuotes funnel, breadth% dial), candidates table (dense, factor columns, evidence-bulletin popovers, congressional composite with its provenance and the go/no-go gate status), macro strip (regime label with inputs on hover, curve, VIX family with panic thresholds marked), watchlist and price-alert manager (armed/triggered states, create inline or via palette).

### 3.10 Alerts & notifications (in Settings, surfaced globally)

An **Inbox** (bell icon) lists `NotificationEvent`s with sent/failed/skipped per channel. Configuration: per-lane `enabledEvents` checklist (fill, block, run_failed, pending_approval, kill_switch, …) wired to per-user channels (push/webhook/email/SMS), where the channel descriptor API drives which rows are even shown as available; each channel row has a **Send test** button. Copy states the two-layer model plainly: "Events are chosen per lane; where they go is chosen once, per user."

### 3.11 Ops (admin)

Dense tables, no decoration: Usage (per-user, per-key LLM tokens/cost with masked keys, operator-funded spend isolated in its own column, RAG usage, budget thresholds with the fail-open note printed: "monitor outage never stops trading"), Providers (per-service per-lane health, consecutive-failure breaker state, error-pattern clusters, tier-watchdog clamps), Pipelines (re-index 10-K/8-K with last-run stamps, web-source refresh, securities import, Robinhood probe — each a button + log tail), Experiments (tuning dry-run, factor-IC backtest, congress evaluation — each renders results inline, clearly marked "no side effects"), Audit (append-only stream, filter by lane/kind/user), Users (allowlist, the owner-can't-be-locked-out guarantee stated), and the ops-snapshot token management.

### 3.12 Mobile companion

The phone is a **pager with a decision surface**, not a mini-desktop. Bottom tabs: **Fleet / Approvals / Tape / More**. Fleet: lane cards with the same Reality treatment + Authority Ladder glyphs + breaker chips. Approvals: full-screen cards, swipe-up for detail; Test/Paper approve via press-and-hold; **Brokerage approvals reuse the identical typed challenge** (`APPROVE LIVE <SYMBOL>`) with the phone keyboard — no biometric shortcut substitutes for the words, matching the server contract. Emergency: `HALT LANE`/`HALT ALL` pinned in More and on every lane card. Everything routes through the durable idempotent command queue, so the UI shows command state honestly: `queued → running → succeeded/failed` chips with results persisted — a subway-tunnel tap can't double-fire or vanish. Arming autonomy and editing live-lane risk limits are deliberately **absent from mobile** (the `policy.patch` allowlist notwithstanding, the design withholds live-risk edits from the phone); the phone can always make things safer, only ceremonially make them riskier (typed live approval), and never arm.

---

## 4. Six highest-stakes flows

### 4.1 First run with fake money

1. Land on first-run checklist (§3.1); Test Lab exists, universe defaulted to sp500, guardrails visible in dollars.
2. User adds LLM key (Settings → Keys; health check pings it, green tick).
3. Clicks **RUN ONCE**. Palette echo: `@test-lab run once — manual runs are always propose-only`. Run tile appears with the live pipeline timeline animating stage-by-stage (scan → LLM → gates).
4. Run completes: toast + Approvals badge = 2. User presses `2`.
5. Queue shows two TEST cards. Detail pane teaches the anatomy: rationale, thesis tag, confidence, reference price, gate preview all labeled with first-time hint callouts (dismiss forever).
6. `a` → light confirm "Approve simulated buy SOFI ~$400 in Test Lab (no real money exists here)" → simulated fill lands on the Tape; position appears with its synthetic stop status.
7. A "What just happened" strip offers: view the Run Inspector for this run; set cadence to make it scheduled; the sentence "This lane will stay halted for scheduled runs until you arm it — Run Once always works."
**Outcome:** the user has executed the entire supervise→approve→audit loop on fake money in under three minutes, and knows the arming concept exists without having touched it.

### 4.2 Arming real money (enabling autonomy on a Brokerage lane)

Entry: lane header → Authority Ladder → "Arm…" (desktop only). A full-screen **Arming Console**, amber-striped:

1. **Preconditions panel** (server-verified live, not client guesses): account selected ✓; universe non-empty ✓; broker reports `agenticAllowed` ✓/✗ (✗ shows the broker's answer and stops here); current systemState.
2. **Choose the rung**: `active + propose` (agent proposes, you approve everything — the recommended live posture, labeled so) vs `active + decide` (agent may place within the cage). Selecting decide expands a **cage summary** — the exact caps that bound autonomy, in dollars, with edit links: max/order $X, max/day $500, hourly $Y ("breach auto-demotes to propose"), drawdown breaker 8%, daily-loss $500, panic brake ON.
3. **Reality restatement**: "Taxable RH is BROKERAGE. Orders placed under decide authority spend real capital without a per-trade human step."
4. **Typed commit**: `ARM LIVE DECIDE <LABEL>` (propose-rung arming on live: `ARM LIVE <LABEL>`; Test/Paper arming: single confirm click — friction proportional to danger).
5. Post-arm state: header ladder fills; the fourth cell (if decide) strips amber; the Fleet row gains the armed-live treatment; an audit event and a `kill_switch`-class notification test-fires so the operator confirms their phone will hear a real breaker.
6. **Boot-interlock education, at the moment it matters**: "If the server restarts, this lane reverts to halted and you must re-arm — unless you opt into auto-resume" with the `autoResumeOnBoot` toggle right there, default off, its own warning.

### 4.3 Approving a live trade

1. Phone push: "Approval needed · Taxable RH (BROKERAGE) · BUY NVDA ~$1,240." Desktop badge simultaneously.
2. Operator opens Approvals (`2`), focuses the card. Reads the diff-oriented detail (§3.4): since-proposed move, drift headroom, revalidation note, Red Team verdict, live gate preview "will pass."
3. Presses `a` → focus jumps into the typed field inside the amber panel showing the exact tuple the server will verify: proposal id, account …4821, mode broker/live, estimated notional $1,240.00.
4. Types `APPROVE LIVE NVDA`. Mismatch (typo, or notional shifted beyond ±$0.01 since render) → the server's `LIVE_CONFIRMATION_REQUIRED` reasons render inline ("estimated notional changed: $1,240.00 → $1,258.40 — re-review") and the field resets; the UI re-fetches the review rather than letting the user retype blindly.
5. Submit → card flips to `placing` with the durable refId shown; SSE flips it to `placed` then the fill lands on the Tape with `source: live`. If the broker declines synchronously: `rejected_by_broker` state with the broker's reason verbatim. If the response is lost: `pending_reconciliation` chip with "broker-truth sweep will resolve; do not retry manually" copy — the idempotency story told in UI words.
6. Double-click / second-session race: the CAS loser gets "already approved at 14:44 by this account" — never a second order.

### 4.4 Emergency stop

Scenario: operator sees fills they don't like on the live lane during a violent tape.

1. Top-right `HALT LANE` (or palette `@taxable halt`, or phone lane card). One click.
2. Confirm sheet, three sentences, big type: "Freezes Taxable RH immediately. No runs, no new orders, no synthetic-stop exits, approvals refused. **Nothing will be sold.**" Buttons: `HALT TAXABLE RH` / cancel. (If the intent is "stop buying but keep my stops," the sheet offers the alternative inline: "Want exits to keep running? Use CLOSE-ONLY instead" — one click switches the action.)
3. Halt lands in <1s (local command, no broker dependency); the lane row turns dark; ladder drops to one cell; a kill-switch notification fans out to every configured channel; audit event written.
4. The lane header now shows a persistent **HALTED banner** with the timestamp, who/what set it, and two exits: "Re-arm…" (full arming console) and "Switch to close-only" (resume protection without entries).
5. Post-incident, the operator uses the Run Inspector + Tape time-range filter to reconstruct; the banner links "what happened around the halt" pre-filtered to ±30 min.

The asymmetry principle: stopping = one click + one confirm, from anywhere, on any device; resuming = the ritual.

### 4.5 Changing a risk limit on a live account

Scenario: raise `maxDailyNotional` from $500 to $1,500 on Taxable RH.

1. Strategy → Policy → Order-size caps. The field row shows current $500, default ghost $500, clamp note. Operator types 1500.
2. Because the lane is Brokerage, saving opens the **Blast Radius sheet** instead of committing:
   - The change, restated in plain trading terms: "The agent may open up to $1,500 of new positions per day on this real-money account (was $500). Closing orders never consume this cap."
   - **Immediate consequences, computed server-side**: today's usage $402 — headroom goes $98 → $1,098 right now; any currently-blocked pending proposals that would now pass are listed by name ("BUY NVDA $1,240 would now clear the daily cap — it remains queued for your approval").
   - Interaction warnings: authority is currently `decide` — "this raises what autonomy can spend today without asking you."
3. Commit: typed `CONFIRM RISK CHANGE` for live lanes (a single generic phrase — the field name is displayed but not typed, keeping the ritual constant while the sheet carries the specifics). Test/Paper lanes: plain Save.
4. The change writes an audit event; the Risk cockpit gauge re-scales with a "changed 14:52" annotation pinned for 24h so tomorrow-you remembers the cage moved; the status strip shows the audit id.
5. Undo affordance: the sheet's confirmation toast offers "Revert to $500" for 10 minutes (a normal, equally-audited counter-edit — no special mechanism, just convenience).

### 4.6 Reviewing why the AI made a decision

Scenario: "Why did it buy AMD yesterday and skip PLTR?"

1. Fastest path: palette `find AMD` → the fill row → `Enter` → Run Inspector #808 with the AMD candidate row pre-focused. (Alternate: Chat drawer, "why did you buy AMD yesterday?" — the assistant answers from `get_reflection`/run data and deep-links the same inspector; chat is a road into the forensics, never a replacement.)
2. In the Inspector: the timeline shows the stage where AMD was chosen; the candidate table shows AMD's composite and factor breakdown next to PLTR's, with PLTR's skip reason verbatim ("below minProposalScoreThreshold" or "corr-cluster with NVDA") and its since-decision counterfactual return.
3. Expanding AMD's row: the full `CandidateEvidence` — every input the model saw, each value with provenance chips and asOf stamps, evidence bulletins, decision-time price, regime.
4. The proposal panel: rationale text, thesis tag, confidence, Red Team transcript (if reviewed), sizing math (conviction → %NAV, corroboration cap, ADV cap — each step shown as applied/not-applied).
5. Gate section: the deterministic gate result at execution time, all reasons.
6. One level up: "How has this kind of decision done?" links to Analytics pre-filtered to thesis=Momentum-Breakout × regime=Late-Cycle — the scorecard cell this trade will feed.
**Outcome:** in ≤4 clicks the operator moves from "a fill happened" to the complete evidence chain, the counterfactual for the road not taken, and the statistical track record of the decision class.

---

## 5. Settings taxonomy

The design draws one hard line and repeats it everywhere: **"How lanes trade" is per-lane and lives in the lane (Strategy/Risk). "Who you are and how the platform reaches you" is per-user and lives in Settings. Platform plumbing is admin-only and lives in Ops."**

**Per-lane (edited under lane scope, always showing lane + reality in the editor header):** the entire `TradingPolicy` — authority, cadence, universe, all caps, entry gates, risk rules, stops plumbing, panic brake, shorts, sell-to-fund, LLM model choice, proposal hygiene, tax settings (`taxationType`, `washSaleGuard`, rates, `subtractFromResults`), per-lane `enabledEvents`, all `tuning.*` — plus the prompt and scoring weights. The lane comparison matrix (Strategy at ALL LANES) makes the per-laneness perceivable: identical fields side by side, deviations highlighted.

**Per-user (Settings, behind avatar):** profile & verified email; notification **channels** (push/webhook/email/SMS targets + tests); API keys (per-provider, masked, health-checked, with the "operator's fallback key may fund you" disclosure for tenants); data-pool consent toggle with a plain explanation of reciprocity; chat model preference and history controls; memory review (MemoryItems with supersede/delete); Profiles library (user-level by definition); the two user-scoped scan overlays (`marketScanCandidateLimit`, `marketScanOutlierReserve`) presented under "Scan defaults (applies to every lane)" with an explicit note that they overlay all lanes — the one deliberate exception, labeled as such rather than hidden; account deletion (two-step, typed `DELETE MY ACCOUNT`, preview of counts, blockers listed with links to clear them).

**Admin (Ops):** allowlist, budgets, provider credentials at platform level, pipelines, leader lease, ops token.

Perception mechanics: per-lane editors are *tinted by the lane's reality* and titled "Taxable RH — Policy"; per-user pages are neutral-chrome and titled "Your settings — applies to all lanes"; any field that overlays lanes carries an "all lanes" pill. The user never has to remember the storage tier — the chrome states it.

---

## 6. Safety model: making dangerous states legible and errors hard

1. **Ambient reality, object-level danger.** The Reality Rail + word labels make the scope's money-reality preattentive; the live treatment applies *per object* so a live proposal in a mixed list is individually marked. No surface ever shows a dollar figure without its bucket (live vs paper) or its reality word nearby.
2. **Asymmetric friction.** Safe-direction actions (halt, close-only, reject, revert, cancel order) are one-click and omnipresent. Risk-increasing actions (arm, live approve, raise a live limit, enable shorts, liquidate, disable wash-sale guard) require typed phrases and full-context sheets. The typed phrases are few and standardized (`APPROVE LIVE <SYM>`, `ARM LIVE [DECIDE] <LABEL>`, `HALT ALL`, `CONFIRM RISK CHANGE`, `LIQUIDATE <LABEL>`, `DELETE MY ACCOUNT`) so the ritual stays meaningful instead of becoming typing noise.
3. **Preview the server's answer before the click.** Approvals show the live gate re-check; policy edits show blast radius; palette commands show resolved lane + effect; arming shows server-verified preconditions. The user should never discover a rejection *after* committing intent — the UI asks the server first and renders the would-be outcome.
4. **State transitions narrate themselves.** Every automatic transition (breaker → close_only, hourly-cap breach → authority demoted to propose, boot → halted, proposal withdrawn by revalidation) produces a persistent, placed banner on the affected lane with cause, timestamp, and the sanctioned next actions — never just a toast that evaporates.
5. **Exits are sacred, visibly.** Close-only and liquidating states show a green "protection active" chip (stop monitor running); halted shows an explicit "protective exits are ALSO frozen" warning — the one state where the user must know their stops are off. Unprotected positions (no bracket, no synthetic stop) are flagged in red in every blotter.
6. **Honest data or no data.** `-` vs `n/a` rendered distinctly with tooltips; synthetic spreads badged; every figure carries asOf on hover, and numbers older than their staleness gate render hollow/outlined. Uncomputable analytics show labeled gaps. Nothing is interpolated, no benchmark fabricated.
7. **Idempotency made visible.** `placing`, `placing_failed`, `pending_reconciliation` are first-class chips with plain-language copy ("intent recorded; broker truth will reconcile — do not manually retry"), converting the durable-intent machinery from invisible plumbing into user-facing calm.
8. **Mode-mismatch refusals are explained, not just refused.** "This proposal was created for Alpaca Paper; you are now scoped to Taxable RH — re-run the strategy before approving" with a one-click re-run.
9. **Screenshots are safe.** Because reality is encoded in words + texture + layout (not color alone or hover state), any screenshot, colorblind rendering, or grayscale print still answers "is this real money."

---

## 7. What to measure

**Safety outcomes (the design's reason to exist):**
- Live-approval typed-challenge failure rate and reasons (typo vs notional-shift vs stale review) — high typo rates mean the challenge is noise; high notional-shift rates mean the diff view isn't being read.
- Time-to-halt: p50/p95 from "operator decides to stop" proxy (first Fleet visit after a breaker push) to halt command landing. Target: <10s desktop, <20s mobile.
- Near-miss count: approvals attempted that the live gate preview showed as "will block" (users clicking through predicted failure = preview not salient).
- Mode-mismatch refusals per week (should trend to ~0 as scope UI teaches).
- Zero-incidence assertions: actions on the wrong lane (measured by immediate-undo/revert within 2 min of a scoped action), un-noticed boot interlocks (lanes left halted >24h post-restart without the banner being acknowledged).

**Supervision efficiency:**
- Approval latency: proposal-created → human decision, by reality and by hour; expiry rate of proposals (high expiry = notification or queue failure).
- Fleet-scan dwell: time from login to first meaningful action; % of sessions resolved entirely from Fleet + Approvals (density working).
- Palette share: % of state-changing commands issued via palette vs mouse (keyboard-first adoption).
- Run Inspector reach: % of blocked/withdrawn/breaker events whose inspector is opened within 24h (are audits actually read).

**Trust calibration:**
- Rejection quality: realized counterfactual of human-rejected ideas vs approved ones (is the human adding value; shown back to the user in the Regret Ledger).
- Decide-authority dwell: time lanes spend at each ladder rung; demotion events (hourly-cap auto-reverts) per lane-month.
- Notification efficacy: per-channel delivery success, and push→action conversion for `pending_approval` and `kill_switch`.

**Instrumentation posture:** all of this is derivable from the existing audit stream, proposal lifecycle timestamps, and notification records — measure from the ledger, don't add client spyware.

---

## 8. Top 10 design principles

1. **Reality is ambient, worded, and textured.** Test/Paper/Brokerage is readable from any pixel-distance, in any screenshot, without color vision — rail, word, stripe, always together.
2. **Scope before verb.** No action exists without a visible, current lane + reality context; the Scope Bar and per-object badges make "which account, which money" a precondition of every interaction, not a detail in a dialog.
3. **One key to stop, a ritual to start.** Friction is proportional to irreversibility and always asymmetric toward safety; halting is instant everywhere, arming is a console.
4. **Show the server's verdict before the commit.** Gate previews, blast radius, precondition checks — the UI renders what will happen, so nothing dangerous is discovered post-click.
5. **The fleet is the home.** The operator supervises machines; state, backlog, and next-run outrank P&L on the first screen.
6. **Approvals are diffs, not tickets.** What changed since the machine proposed — drift, revalidation, freshness, counterfactual-so-far — is the decision-relevant information; static order details are secondary.
7. **Every automatic action leaves a placed, persistent trace.** Breakers, demotions, withdrawals, interlocks narrate themselves on the affected lane until acknowledged; toasts are never the only witness.
8. **Honest absence beats fabricated presence.** `-` vs `n/a`, hollow stale numbers, labeled gaps, provenance chips on every enriched value — the UI inherits the platform's provenance ethic pixel-for-pixel.
9. **Real and simulated money never share an axis.** Buckets are summed, charted, and celebrated separately, always.
10. **The keyboard is a first-class client.** Everything state-changing flows through the same audited command grammar (palette = mobile queue = buttons); speed for the expert never bypasses the ledger or the rituals.

---

## Appendix: keyboard map (desktop)

`1-9,0` destinations · `Ctrl+1..9` lane scope, `Ctrl+0` ALL LANES · `Cmd+K` palette · `Ctrl+/` chat drawer · `j/k` row nav · `Enter` inspect · `a/r` approve/reject (typed challenge intercepts on live) · `t` focus tape · `g r` goto runs, `g p` positions (chords) · `?` overlay of this map.
