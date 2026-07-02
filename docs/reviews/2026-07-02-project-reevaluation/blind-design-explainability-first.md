# LEDGERLINE — An Explainability-First Interface for an Agentic Trading System

*A blind, bottom-up design produced solely from the capability inventory. Design lens: trust and auditability. The organizing idea: the entire interface IS the audit trail, and the audit trail is where you act.*

---

## 0. Design stance

This product asks a human to let a language model touch money. The single design problem that dominates everything else is: **the user must be able to reconstruct, at any moment, why any dollar moved or didn't — and act on that reconstruction with confidence.**

The system already produces the raw material: every run persists a full `signal_snapshot` of chosen *and* skipped candidates; every proposal carries a `rationale`, a `tradeThesisTag`, an `entryMarketRegime`, a `referencePrice`, and a `confidenceScore`; every gate emits machine-readable `reasons[]`; every fill is stamped with `executionMode` and `source`; rejected ideas accrue `performanceSinceProposalPct`; every learning mutation is ledgered with a prior-state snapshot. Most trading UIs would bury this under a P&L chart. Ledgerline does the opposite: **the decision lifecycle is the information architecture.**

The lifecycle is:

> **SIGNAL → THESIS → CHALLENGE → GATE → APPROVAL → EXECUTION → OUTCOME → LEARNING**

Every screen in the product is a station on this line. Every object in the product (a candidate, a proposal, a fill, a scorecard row, a weight change) is a *car on the line* that you can follow forward to its consequences and backward to its evidence. The core navigational verb is not "browse" — it is **trace**.

Three subordinate commitments follow:

1. **Every number wears its passport.** The system records per-field provenance (`sources`), timestamps (`asOf`, `generatedAt`), and the honest distinction between "computed no-value" (`n/a`) and "not available" (`-`). The UI renders all three, always, at the point of use — never in a tooltip-only ghetto.
2. **Every configuration change is a diff.** Policy, prompt, and weights are versioned law. You never "save settings"; you *review and commit a change*, with the before/after visible, and the ledger remembers.
3. **Danger is spelled, not colored.** The system's own invariant is word-first money-reality (Test / Paper / Brokerage; `APPROVE LIVE <SYMBOL>`). The UI extends this: every dangerous state is named in words at the point of action, and the words are load-bearing (typed confirmations), not decorative.

---

## 1. Information architecture & navigation

### 1.1 The navigation model: a lifecycle spine plus a law book

Primary navigation is a left rail ordered top-to-bottom in **lifecycle order**, so the nav itself teaches the mental model. Two sections sit below the spine: the "law" (things you configure that constrain the lifecycle) and "infrastructure."

```
┌──────────────────────────┐
│  LEDGERLINE              │
│                          │
│  THE LINE                │
│  ● Now                   │  ← mission control: where every account is on the line
│  ● Signals               │  ← market scan, evidence, macro & regime, watchlist, price alerts
│  ● Runs                  │  ← one row per strategy session; the run is the atomic audit unit
│  ● Decisions             │  ← proposal inbox + decision ledger + the Counterfactual Shelf
│  ● Positions & Orders    │  ← execution reality: holdings, working orders, protective exits,
│  │                          reconciliation queue
│  ● Outcomes              │  ← performance, scorecards, calibration, MAE/MFE, tax
│  ● Learning              │  ← reflections, tuning proposals, learning ledger, shadow ledger,
│                             pending learned-context approvals
│                          │
│  THE LAW                 │
│  ▸ Strategy Studio       │  ← prompt, scoring weights, thesis playbook, profiles library
│  ▸ Risk & Policy         │  ← caps, breakers, exits, states — the versioned Policy Ledger
│                          │
│  INFRASTRUCTURE          │
│  ▸ Assistant (chat)      │
│  ▸ Settings              │  ← accounts, keys, notifications, consent, data & deletion
│  ▸ Admin                 │  ← operator-only: users, cost, provider health, ops
└──────────────────────────┘
```

**Why this shape:**

- **Now** exists because monitoring an autonomous agent is fundamentally different from browsing a brokerage. The question is not "what do I own" but "what is the machine about to do, under what authority, with how much room left." Now answers that per account, per lifecycle stage.
- **Signals** comes before Runs because that's where evidence is born. Every enriched value here is the *source end* of a trace that may terminate in a fill weeks later.
- **Runs** is its own destination — not a log buried in settings — because the run is the system's natural audit unit: one scan, one debate, one gate pass, persisted evidence (`candidates_considered`, `signal_snapshot`, `rationale_diversity`). A run row is the table of contents for everything the agent did in one sitting.
- **Decisions** is the heart of the product and the default landing surface when anything is pending. It merges the approval inbox with the historical ledger because *approving and auditing are the same activity performed at different tenses.* It also houses the Counterfactual Shelf (rejected/blocked/skipped ideas with their realized "since then" returns) — because a system that scores what you turned down deserves a room where you confront that.
- **Positions & Orders** separates *intent* (Decisions) from *reality* (broker truth). Reconciliation states (`placing_failed`, `pending_reconciliation`) live here, visible, never hidden — an orphaned intent is a first-class citizen with a badge, not a support ticket.
- **Outcomes** and **Learning** are separate: Outcomes is *measurement* (what happened), Learning is *adaptation* (what the machine wants to change about itself). Conflating them would hide the most sensitive thing the system does — modifying its own weights — inside charts.
- **Strategy Studio** vs **Risk & Policy** split "what the agent tries to do" (prompt, weights, playbook — the *offense*) from "what it may never do" (caps, breakers, states — the *cage*). Users think of these differently; the novice touches only Risk & Policy's simple mode and never opens the Studio.

### 1.2 The universal object: the Trace

Every entity — candidate, proposal, order, fill, position, alert, weight change — renders with a **Trace glyph (⧉)**. Clicking it opens the **Decision Dossier** (§3.4): a single permalinked page assembling the entire lifecycle chain for that entity. The Dossier is the product's atom of explainability; the rest of the UI is ways to arrive at one.

### 1.3 Account scoping

Everything on the lifecycle spine is scoped to **one account at a time** (matching the system's per-account policy/state/scheduler model). The account is selected in the global chrome (§2), never inside a page. Cross-account surfaces are explicitly marked: the wash-sale lockout list (inherently cross-account, per IRC §1091 semantics), the profiles library (user-level), notification preferences (user-level), and Admin.

---

## 2. The global frame: chrome that never lies

### 2.1 The Reality Bar (always visible, top of every screen, both desktop and mobile)

```
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ ⬤ Roth IRA · Alpaca  [ BROKERAGE — real money ]   STATE: ACTIVE   AUTHORITY: Propose       │
│ Today: $312 of $500 daily cap · 2 of 10 orders     Next run 12:47 (in 09:14)   [ HALT ■ ]  │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

Contents, left to right:

1. **Account scoper** — label + broker + the **money-reality word chip**. The three chips are typographically distinct, not merely colored (color-blind-safe and screenshot-safe):
   - `TEST — simulated, this app` : dotted outline, prefixed ⌾. Sub-line on hover: "Local simulator. Not any broker's paper account."
   - `PAPER — broker sandbox` : dashed outline, prefixed ◻. "Real broker endpoints, no real capital."
   - `BROKERAGE — real money` : solid filled chip, prefixed ⬤, and the words "real money" are always in the chip. This chip never abbreviates.
   These words come from `deriveExecutionState` — derived server truth, never client guess.
2. **System state word** — `ACTIVE / HALTED / CLOSE-ONLY / LIQUIDATING`, rendered as a word, with the state's one-line law beneath on hover ("Halted: nothing trades, including protective exits. Halting never sells.").
3. **Authority word** — `Propose` (human approves everything) or `Decide` (agent may place). On a Brokerage account, `Decide` renders with a persistent underglow and the phrase "agent may place real orders."
4. **The Spend Odometer** — live consumption of `maxDailyNotional` and `maxDailyOrders` ("$312 of $500 · 2 of 10 orders"), plus the rolling `maxHourlyNotional` when >50% consumed. This is the answer to the novice's constant question, *what can it spend right now?*, kept in peripheral vision at all times.
5. **Next-run countdown** — from the account's own cadence clock; shows "market closed — next window Mon 9:30" when the calendar blocks; shows "run in progress ▸" with a link to the live run when running.
6. **HALT** — a physical-feeling square button, always present, always one click + one confirm away (§4.4). Never buried in a menu.

**Rule: the Reality Bar is unhideable and identical on every screen, including Settings, Admin, and chat.** If a screenshot of any part of the app exists, the money-reality of what it shows exists in the screenshot.

### 2.2 The Event Ticker (bottom edge, collapsible to one line)

A live, append-only strip fed by SSE (`dashboard.run-complete`, `dashboard.proposal`, `dashboard.order`, breaker events): "12:31 Run #482 complete — 2 proposed, 1 blocked ⧉ · 12:29 Stop-loss trim NVDA queued ⧉ · 11:58 Circuit breaker: daily loss $-212 → CLOSE-ONLY ⧉". Every entry has a Trace glyph. The ticker is the audit trail's leading edge, in the chrome.

### 2.3 Boot banner

Whenever the server process has restarted since the user's last session, a dismiss-only-by-reading banner appears under the Reality Bar:

> ⟳ **The system restarted at 06:12.** Per the boot interlock, accounts that were ACTIVE were reverted to HALTED (audited). Roth IRA and Taxable were affected. [Review & re-arm] [View audit entry ⧉]

The interlock is one of the system's best safety properties; the UI makes it *visible* rather than a surprise ("why didn't it trade today?").

---

## 3. Screen designs

### 3.1 First-run (onboarding): "Watch it think before you let it touch anything"

Design goal: get the user to a completed **Test-mode run with a real market scan** in under three minutes, with zero credentials, and make the safety model felt rather than read.

```
┌──────────────────────────────────────────────────────────────┐
│  Welcome. Here is the one rule of this product:              │
│                                                              │
│   The AI proposes. Deterministic rules constrain.            │
│   You decide anything that touches real money.               │
│                                                              │
│  You're starting in TEST — a simulator inside this app       │
│  with $10,000 of pretend cash marked to live prices.         │
│  It is not a broker account. Nothing here is real.           │
│                                                              │
│  Step 1 · Pick a universe        [ S&P 100 ▾ ]  (default)    │
│  Step 2 · Guardrails (you can change these any time)         │
│      Per-order cap   $ [ 500 ]                               │
│      Daily cap       $ [ 500 ]                               │
│      Stop-loss       [ 8 ]%     Take-profit  [ 20 ]%         │
│      (≈46 more rules are active with safe defaults —         │
│       see the full rulebook after your first run)            │
│  Step 3 ·  [ ▶ Run the strategist once ]                     │
│            Runs in Propose mode: it can only suggest.        │
└──────────────────────────────────────────────────────────────┘
```

Notes:
- The LLM key requirement is handled honestly: if no `OPENAI_API_KEY`-class credential exists, Step 3 becomes "Add an LLM key to run the strategist — everything else (scan, watchlist, simulator) works without one," with the scan demo offered instead. **Never a fabricated fallback run** (matches the fail-closed invariant).
- While the first run executes, the screen becomes a **live pipeline view** — the same component used in Run Detail (§3.3) — so the user's first experience of the product is literally watching the lifecycle stations light up: Scan → Score → Propose → Red-Team → Gate → Queue. This is the single highest-leverage trust moment in the product; we spend it showing the machinery, not a spinner.
- The run ends on the Decisions inbox with 1–3 Test proposals, and a callout: "Nothing was bought. These are proposals. Open one to see its full dossier."
- Broker connection is deliberately **not** in onboarding. A quiet card at the end: "When you're ready for a broker sandbox or real account: Settings → Accounts. Test mode works forever and is free."

### 3.2 Now (mission control)

One screen answering: what reality am I in, what is the agent doing, what needs me, what changed.

```
┌ Reality Bar ────────────────────────────────────────────────────────────────┐
├─────────────────────────────────────────────────────────────────────────────┤
│  NEEDS YOU (3)                                                              │
│  ┌───────────────────────────────┐ ┌───────────────────────────────┐        │
│  │ ⬤ APPROVAL · BROKERAGE        │ │ LEARNED FACT PENDING          │        │
│  │ BUY NVDA ≈ $480               │ │ "Avoid biotech pre-FDA" (risk)│        │
│  │ Momentum-Breakout · conf 84   │ │ from: autonomous reflection   │        │
│  │ proposed 22 min ago            │ │ [Review]                     │        │
│  │ since proposal: +0.6% ↗       │ └───────────────────────────────┘        │
│  │ [Open dossier ⧉]  [Decide…]   │ ┌───────────────────────────────┐        │
│  └───────────────────────────────┘ │ RECONCILIATION (1)            │        │
│                                    │ placing_failed · AAPL sell    │        │
│                                    │ [Resolve ⧉]                   │        │
│                                    └───────────────────────────────┘        │
│  THE LINE — where this account is in the cycle                              │
│  Signals ─▶ Thesis ─▶ Challenge ─▶ Gate ─▶ Approval ─▶ Execution ─▶ Outcome │
│   12:31 ✓    2 made    1 debated   1 blocked  1 waiting   0 placed    …     │
│  Last run #482 (12:31) — "Proposed NVDA, MSFT; blocked XOM (sector cap)"    │
│  [Open run ⧉]                                    Next run in 09:14          │
│                                                                             │
│  ACCOUNT VITALS                          PORTFOLIO (BROKERAGE bucket)       │
│  Equity $10,412 (+0.8% today)            5 positions · 1 working order      │
│  Drawdown from high-water: -2.1%         Protective exits: 5/5 covered      │
│    breaker trips at -10%  [▓▓░░░░░░░]      (3 broker brackets, 2 synthetic) │
│  Daily loss: -$88 of -$300 breaker       Wash-sale locks: TSLA (11d left)   │
│  VIX 18.4 · regime: RISK-ON              [Positions ⧉]                      │
│                                                                             │
│  RECENT DECISIONS (ledger tail)     ·  COUNTERFACTUAL SHELF (teaser)        │
│  ✓ approved MSFT $410 (Test) ⧉      ·  You rejected AMD 6d ago: +4.2% since │
│  ✗ you rejected AMD ⧉               ·  Gate blocked XOM: -1.1% since        │
│  ⊘ blocked XOM — sector cap ⧉       ·  [Open the shelf]                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

Opinions embedded here:
- **"Needs you" outranks P&L.** The top of mission control is the human-in-the-loop queue, because unattended pending items are where value and safety leak (proposals expire at `proposalExpiryMinutes`; expiry countdowns are shown on each card).
- **The Line strip** renders the last run as stations with counts, making "the agent ran and did nothing" a legible, positive event (the do-nothing gate is shown as "Gate: all candidates below score floor — no LLM call made ⧉", not silence).
- **Breaker proximity meters** (drawdown vs `maxDrawdownPct`, daily loss vs `maxDailyLossNotional`) are shown as fuel gauges *before* they trip. Circuit breakers you can see approaching are policy; ones that surprise you are trauma.
- **Protective-exit coverage** ("5/5 covered, 3 broker / 2 synthetic") makes the stops plumbing auditable at a glance — and "broker-held" vs "synthetic (app must be running)" is an honesty distinction worth the pixels.

### 3.3 Runs (list + Run Detail: the audit unit)

**Runs list:** a reverse-chronological table — status, time, duration, mode chip, counts (`proposed/placed/paper/blocked`), a one-line `summary`, and anomaly badges (breaker tripped, red-team veto, rationale-diversity warning, run failed).

**Run Detail** is a vertical replay of the pipeline, each stage expandable, everything traceable:

```
RUN #482 · 12:31:04–12:31:58 · BROKERAGE · scheduled (cadence 60m)
Summary: "Proposed NVDA, MSFT; blocked XOM (sector cap); withdrew stale PYPL idea."

▸ 0 · PRECONDITIONS          lock acquired · fills reconciled (0 pending) · account agenticAllowed ✓
▸ 1 · SNAPSHOT (pre)         equity $10,398 · cash $2,140 [view raw]
▸ 2 · BREAKERS               drawdown -2.1% (limit 10) ✓ · daily loss -$88 (limit $300) ✓
                             vol panic: VIX 18.4/40 · VVIX 92/150 · SKEW 138/160 ✓
▸ 3 · PROPOSAL HYGIENE       expired 0 · re-validated 3 → withdrew PYPL
                             "withdrawn: earnings catalyst passed; thesis no longer holds" ⧉
▾ 4 · SIGNAL — market scan   12:31:11 · sources: nasdaq-delayed-screener+finnhub+yahoo-finance
                             scanned 2,841 · scored 2,614 · enriched top 30 (+2 outlier reserve)
                             breadth 61% advancing → regime input · warnings: none
                             [Open full scored table — chosen AND skipped]
▾ 5 · THESIS — proposer      model gpt-5.4-mini · effort medium · [prompt used ⧉ · v14]
                             3 candidates emitted; 1 dropped by negative-expectancy skip
                             NVDA · Momentum-Breakout · conf 84 · sized $480 (conviction-scaled,
                             ADV-capped) · referencePrice 512.30
▾ 6 · CHALLENGE — red team   NVDA conf 84 ≥ threshold 80 → debated
                             ┌ BULL: breakout above 50d on 2.1× volume; analyst revisions up;
                             │ sector RS top decile.
                             └ BEAR: extended 9% above 20d; earnings in 6 days (gap risk);
                               crowded long per positioning.  VERDICT: SURVIVES, size unchanged.
                             (If red team had been unavailable: "review unavailable → routed to
                              human approval — fail-closed" would render here.)
▾ 7 · GATE — deterministic   NVDA: 31 checks · 31 pass  [expand checklist]
                             XOM:  BLOCKED — sectorCaps: Energy at 19.4% + $310 order → 22.1%
                                   > 20.0% cap  → recorded to Counterfactual Shelf ⧉
▸ 8 · APPROVAL ROUTING       2 queued for human (authority: Propose) · notified: push ✓ webhook ✓
▸ 9 · EXECUTION              (none this run)
▸ 10 · EVIDENCE PERSISTED    signal_snapshot (2,614 rows) · candidates_considered ·
                             rationale-diversity: PASS (0.71) · counterfactual jobs queued
▸ 11 · SNAPSHOT (post) & REFLECTION trigger · SSE dashboard.run-complete
```

The **"chosen AND skipped"** table in stage 4 is a sortable grid of the entire scored set with factor breakdowns and per-field provenance chips — the antidote to "why NVDA and not AMD?" You sort by score, see AMD at rank 4, click it, and see exactly which factor and which gate separated it from a proposal.

### 3.4 Decisions — the inbox, the ledger, and the Decision Dossier

**Layout:** three tabs. **Inbox** (pending `proposed`, expiry countdowns, batch reject but never batch approve), **Ledger** (every terminal decision, filterable by status/thesis/regime/mode), **Counterfactual Shelf** (§3.4.2).

#### 3.4.1 The Decision Dossier (the product's atom)

One permalinked page per proposal, rendered as a vertical evidence chain in lifecycle order. This exact page serves as: the approval surface (when pending), the audit record (forever after), and the link target for every notification.

```
┌ DOSSIER · P-1847 ───────────────────────────────────────────────┐
│ BUY NVDA · ≈$480 (market, GFD, regular hours)                   │
│ ⬤ BROKERAGE — real money · Roth IRA · status: PROPOSED          │
│ expires in 41:12 · proposed by run #482 ⧉                       │
│─────────────────────────────────────────────────────────────────│
│ 1 SIGNAL   score 8.42 (rank 1 of 2,614) · regime RISK-ON        │
│   momentum 9.1×1.2  liquidity 8.8×1.4  value 4.2×0.8 …          │
│   price 512.30 ᶠⁱⁿⁿʰᵘᵇ 12:31  ·  P/E 38.1 ʸᵃʰᵒᵒ  ·  target      │
│   mean 590 ᶠᵐᵖ  ·  short float 2.1% ᶠⁱⁿʳᵃ  ·  days→earnings 6  │
│   insider n/a · congress —      [every value: provider + asOf]  │
│   evidence bulletins: "8-K filed 06-28: guidance raised" ⧉kb    │
│ 2 THESIS   Momentum-Breakout · confidence 84                    │
│   "Breakout above 50-day on 2.1× volume with upward analyst     │
│    revisions; sector relative strength top decile…"             │
│   thesis track record: 58% win, +1.9% avg (23 closed) — and     │
│   in RISK-ON specifically: 64% win (14) [scorecard ⧉]           │
│ 3 CHALLENGE  red-team debated (conf ≥ 80) — SURVIVED            │
│   bear case preserved verbatim ▸                                │
│ 4 GATE     31/31 passed at proposal · re-runs at approval       │
│   entry drift now: +0.6% of 10% allowed ✓ · caps after this     │
│   order: $792 of $500 daily → ⚠ WILL BLOCK unless…  (live)      │
│ 5 APPROVAL  ← YOU ARE HERE                                      │
│   [ ✗ Reject ]                [ Approve — requires typing ▸ ]   │
│   Rejecting records a counterfactual: we keep scoring this      │
│   idea and show you what it does after you pass.                │
│ 6 EXECUTION (pending)                                           │
│ 7 OUTCOME   since proposal: +0.6% (ref 512.30 → 515.4)          │
│ 8 LEARNING  will feed: thesis scorecard, calibration bin 80-90, │
│   factor IC, MAE/MFE                                            │
└─────────────────────────────────────────────────────────────────┘
```

Details that matter:
- **Provenance chips** (superscript provider tags) on every number, with `asOf` on hover; `n/a` renders in plain text ("computed: no ratio — negative earnings"), `-` renders as a hollow dash with "not available from any configured source." The two are visually non-interchangeable, matching the system's hard rule.
- **Stage 4 is live**, not archival: approval re-runs everything server-side, so the dossier pre-computes and displays *current* drift vs `referencePrice`, current cap headroom, wash-sale set membership, staleness — the user sees what the gate will see *before* committing, and a would-block condition is surfaced as a warning, not discovered as an error.
- **Stage 2 embeds the thesis scorecard inline** — "this playbook, in this regime, has done X" — which is the single most decision-useful piece of context the system can offer a human approver.
- Terminal dossiers keep all eight stages and append what happened: the fill (with `brokerOrderId`, slippage vs reference), MAE/MFE once annotated, exit linkage, and the run-attribution credit.

#### 3.4.2 The Counterfactual Shelf

A dedicated grid of every road not taken — `rejected` (by you), `blocked` (by the gate), `withdrawn` (by re-validation), and top *skipped* candidates — each with its decision-time `refPrice`, the realized side-adjusted return since, and who/what said no.

```
COUNTERFACTUAL SHELF          [30d ▾]  [benchmark-relative ◻]
IDEA        SAID NO      WHEN   REASON              SINCE THEN
AMD  buy    You          6d     "too extended"      +4.2%  (SPY +0.8%)
XOM  buy    Gate         2h     sector cap 20%      -1.1%
PYPL buy    Re-validation 1d    catalyst passed     -0.3%
COIN buy    Red team     9d     "crowded, HTF risk" +7.9%  ⚠ pattern?
Summary: your rejections underperformed taking them by -1.8% net (12 ideas);
the gate's blocks saved +0.4%.  [Full missed-opportunity report → Outcomes]
```

This shelf is deliberately uncomfortable. Trust in an AI system is not built by hiding its wins over you; it's built by showing the full ledger both ways — including when saying no was right.

### 3.5 Positions & Orders

- **Positions table:** side-aware (negative qty = SHORT, worded), avg cost, market value, unrealized P&L, **protection column** ("bracket @ 471.30 ᵇʳᵒᵏᵉʳ⁻ʰᵉˡᵈ" / "trailing 8% ˢʸⁿᵗʰᵉᵗⁱᶜ — requires app up" / "⚠ UNPROTECTED"), tax column (daysHeld, `daysToLongTerm` countdown, `earlyExitTaxPremium` on hover), wash-lock badge.
- **Working orders:** each with age; a limit order older than `staleLimitOrderMinutes` gets a stale badge and the one-action **[Replace with market ▸]** (which routes through the same gate; the dossier records the replacement).
- **Reconciliation queue:** `pending_reconciliation` fills and `placing_failed` intents rendered as amber cards with the idempotency `refId`, the `clientOrderId` broker-truth match status, and explicit next actions. Never auto-dismissed. The empty state says: "No orphans. Every order intent is accounted for." — a sentence that earns trust precisely because the queue exists.

### 3.6 Strategy Studio (the offense)

Four panels, all versioned:

1. **Prompt** — the free-text strategy prompt in a plain editor with version history ("v14 · edited 06-28 · diff ▸"). A "used by run #…" backlink list shows exactly which runs executed under which prompt version.
2. **Scoring weights** — 8 sliders (`liquidity, momentum, value, quality, volatility, sentiment, positioning, diversification`) each annotated with its **realized IC** from the factor scorecard ("momentum: IC +0.06 over 90d") so tuning is evidence-adjacent, not vibes. A "proposed by tuner" ghost handle appears when a pending `StrategyTuningProposal` exists.
3. **Thesis playbook** — the fixed tag vocabulary as cards with per-tag scorecards; tags can't be edited (bounded vocabulary is a feature), but per-tag notes can.
4. **Profiles library** (user-level) — named presets `{name, policy, prompt, scoringWeights}`. The **Apply** action opens a three-way diff (preset vs target account's live state, with the target's `systemState` row pinned and stamped "NEVER CHANGED BY A PRESET"), requires picking the target account explicitly by its full reality-worded name, and stamps provenance (`derived_from_profile_id`). Copy-not-link semantics are stated on the button itself: "Copies onto Roth IRA — later edits to this preset won't follow."

### 3.7 Risk & Policy (the cage) — the Policy Ledger

Two modes, one truth:

- **Simple mode (default):** the four novice guardrails (per-order cap, daily cap, stop-loss %, take-profit %) as large controls, plus the three big switches (short selling — off; extended hours — off; sell-to-fund — off) each with a one-sentence consequence. A footer: "46 more rules are active with safe defaults · [Open the full rulebook]".
- **Full rulebook:** every policy field, grouped exactly as the domain groups them (Run state & authority / Universe / Order-size caps / Exposure caps / Entry-quality gates / Risk rules / Stops plumbing / Panic brake / Shorts / Tax / Notifications / Tuning). Each field shows: current value, default value, a plain-language sentence ("`maxEntryDriftPct` 10% — a queued buy is refused if the price has moved more than 10% from where the idea was priced"), and a **history glyph** opening that field's change log.

**The commit model (the load-bearing idea):** editing never saves live. Edits accumulate into a **pending changeset**; a sticky bar reads "3 uncommitted changes · [Review & commit ▸]". Review shows a unified diff:

```
POLICY CHANGE · Roth IRA · ⬤ BROKERAGE — real money
- riskRules.stopLossPct        8  →  12
- maxDailyNotional          $500  →  $1,000
- tuning.skipNegativeExpectancy  off → on
Impact preview (advisory): with today's positions, stop distance on NVDA
moves from 471.30 to 450.82; daily headroom right now becomes $688.
Note (required on Brokerage): [ widening after 3 whipsaw stops        ]
                                   [ Discard ]  [ Commit changes ]
```

Commits append to the **Policy Ledger** — an immutable per-account timeline of every change (human commits, mobile `policy.patch`, tuner applies, breaker auto-reverts like the `maxHourlyNotional` → `propose` downgrade, boot-interlock halts) each with actor, source, diff, and note. Any past version can be diffed against now. This is also where the **tuning autonomy** family lives, gated behind its own sub-page with the shadow ledger toggle presented first ("run it in shadow for a while before letting it touch weights").

The four **system state** controls render as a horizontal state machine with the semantics written on the controls themselves:

```
[ ACTIVE ]  [ CLOSE-ONLY ]  [ LIQUIDATING ]  [ HALTED ]
  trades      no new buys;     exits only,      NOTHING moves —
  per          exits & stops    deliberately     not even stops.
  authority    still work       winding down     Halting never sells.
```

### 3.8 Outcomes (results & analytics, incl. tax)

Sub-tabs: **Performance / Scorecards / Calibration / Counterfactuals / Tax**.

- **Performance:** dual-bucket equity curves (LIVE vs PAPER buckets, never merged — Test and Paper both book to paper, and a legend note says so), SPY benchmark overlay normalized to 100 with account/benchmark/excess totals, per-run attribution with the dual entry/exit credit split, all rendering "insufficient data" as an absent series with a sentence — never an extrapolated line. An `subtractFromResults` toggle re-renders everything after-tax with an "estimates, not advice" watermark.
- **Scorecards:** thesis × regime matrix (win rate / avg return / n, cells with n < threshold ghosted "insufficient sample"), sector, signal-efficacy ("evidence present at decision time → subsequent win rate"), factor IC table, MAE/MFE per thesis ("pain endured vs move available vs captured" as a three-band bar).
- **Calibration:** stated `confidenceScore` bins vs realized win rate, the single most important chart for deciding whether to ever grant `decide` authority. Annotated plainly: "When the agent says 84, it has been right 61% of the time (n=31)."
- **Tax:** YTD realized ST/LT with estimated liability; `washSales[]` with disallowed dollar amounts; **lockedSymbols** with day countdowns (mirrored as badges everywhere buys appear); openLots grid sorted by `daysToLongTerm` with `earlyExitTaxPremium` ("selling MSFT today costs an extra ~$41 vs waiting 12 days"); harvestCandidates ranked. IRA accounts show the same page with rates zeroed and a sentence explaining why. Header on everything: "Estimates only — not tax advice."

### 3.9 Signals (scan, macro, watchlist, price alerts)

- **Scan:** the enriched candidate grid with the composite score, factor breakdown popovers, provenance chips per cell, `generatedAt` + cache badge ("cached 3m ago"), breadth gauge, and the source chain string verbatim. The outlier-reserve rows are labeled "outlier reserve: 2 congressional buyers, net positive" — the *reason* they jumped the cutoff is the label.
- **Macro & regime:** the FRED panel with each series dated; the derived **regime word** displayed with its inputs ("RISK-ON: breadth 61%, curve normal, VIX 18") because the regime stamps every trade and deserves its own explanation.
- **Price alerts:** symbol / op / price / note; `armed → triggered` history with trigger price/time; creation inline or via chat/mobile.

### 3.10 Assistant (chat)

A right-side drawer available everywhere (context-aware: opened from a dossier, it's pre-scoped to that trade). Hard UI rules: every tool call the model makes renders as a visible chip in the transcript ("→ get_portfolio_pnl"); grounded answers cite their tool outputs; and **draft orders are visually a different species** — a dashed "DRAFT TICKET" card that must be explicitly promoted ("Promote to proposal → goes through the same gates and approvals as everything else"), never a chat bubble that looks like a done deal. The drawer footer repeats the registry truth: "The assistant cannot execute trades. It can draft, look up, and alert."

### 3.11 Settings

Grouped by scope (see §5): **Accounts** (connect/OAuth/keys, capabilities snapshot rendered as a read-only "what your broker allows" card — `agenticAllowed`, options level, margin, shorting — with absent capabilities shown as "not confirmed by broker = off"), **API keys** (per-provider, masked, health dot per credential lane), **Notifications** (channel descriptors from the server: only channels the deployment supports are shown, each with its target field and a [Send test] button; per-account event checkboxes for the `enabledEvents` list), **Consent** (the reciprocal data-pool opt-in with a plain explanation of exactly what is shared), **Data & deletion** (the two-step typed `DELETE MY ACCOUNT` flow with the counts preview and blocker list rendered as a checklist).

### 3.12 Admin (operator only)

Dense, tabular, honest: **Users & spend** (per-user, per-key LLM/RAG cost, "operator-funded" usage highlighted as its own column with a monthly budget bar and alert thresholds), **Provider health** (service × credential-lane grid: green/amber/red from consecutive-failure detection, error-pattern clusters expandable to raw log, tier-watchdog clamp events flagged), **Pipelines** (re-index 10-K/8-K, web-source refresh, securities import — each a job card with last-run/duration/result), **Diagnostics** (broker probes, tuner dry-run, factor-IC backtest, congress gate evaluation — all "exercise without side effects" and labeled so), **Ops** (scheduler heartbeat age, readiness endpoints, single-leader lease status, ops-token management). A banner clarifies the budget monitor's fail-open stance: "Budget alerts never stop trading; they only tell you."

### 3.13 Mobile

The phone is a **remote control and an approval device, not a cockpit.** Its IA is a subset: **Now / Decide / Positions / Halt.**

- Every action is a queued command with visible lifecycle (`queued → running → succeeded/failed`) — the UI shows the state chip on the button itself after tap, because the command queue is durable and observable, not instant. Optimistic UI is banned here.
- **Decide** is a card stack of dossier summaries (stages 1–4 condensed to: thesis sentence, confidence + track record line, red-team verdict, gate status, since-proposal move). Reject is a swipe; **Approve is never a swipe** — it opens the full-screen confirmation (typed `APPROVE LIVE <SYMBOL>` for Brokerage, keyboard-only, no paste on the live path).
- **Halt** is a persistent bottom-bar element on every mobile screen: press-and-hold 1.5s → state picker (Halt / Close-only) → confirm. Push notifications (fill, block, pending_approval, kill_switch, price_alert) deep-link to dossiers.
- The Reality Bar compresses to its two most vital words: the reality chip and the state word, always in the header. Secrets never on the phone; session token only (matching the platform contract).

---

## 4. The six highest-stakes flows

### 4.1 First run with fake money

1. Land on onboarding (§3.1). Reality chip reads `TEST — simulated, this app`; copy explicitly disambiguates Test from broker paper.
2. Accept defaults (S&P 100, $500/$500, 8/20). Tap **Run the strategist once**. The button sublabel: "Propose mode — it can only suggest." (Manual runs are *forced* to propose authority server-side; the UI states the guarantee it inherits.)
3. Watch the live pipeline light up station by station (~30–60s): scan sources appear as they contribute; the red-team debate streams if triggered; the gate checklist ticks.
4. Land on Decisions inbox: 1–3 Test proposals. A coach mark points at the Trace glyph: "Everything in this product can answer 'why'."
5. Open a dossier; approve (Test = one click, no typed text — the friction gradient teaches reality levels by contrast). The paper fill appears in the ticker; Positions shows the simulated holding with its protective exits already attached.
6. Exit state: a card offers "Schedule it: run every 60 minutes while the market is open" → flips `systemState` to ACTIVE with the arming checklist (trivially green in Test).

### 4.2 Arming real money (enabling autonomy on a Brokerage account)

Arming = putting a `broker/live` account into `ACTIVE`, and separately, granting `decide`. The design splits these into two deliberate rituals and never bundles them.

1. **Precondition checklist renders first** (server-enforced facts, shown as gates, each linking to its fix): account selected ✓ · broker reports `agenticAllowed` ✓ · universe non-empty ✓ · at least one completed Test or Paper run on this policy (soft check — advisory) · protective exits configured ✓.
2. **The rehearsal requirement (soft but sticky):** if this exact policy changeset has never run in Paper, the UI interposes: "This rulebook has never traded in a sandbox. [Run it once in Paper first] [Arm anyway — type why]". Refusing the rehearsal requires a free-text reason that lands in the Policy Ledger.
3. **The arming card** restates money-reality in words: "You are activating **scheduled runs** on **Roth IRA · ⬤ BROKERAGE — real money**. Authority is **Propose**: every trade still requires your typed approval. Caps: $500/order · $500/day · 10 orders/day."
4. Typed confirmation: **`ARM ROTH IRA`** (account label, not a generic word — muscle-memory-proof).
5. Ledger entry written; Reality Bar flips to `ACTIVE`; the ticker announces the next run time.
6. **Granting `decide` is a separate flow** on the Authority control, gated by evidence: the card embeds the calibration chart and thesis scorecards ("the agent's 80+ confidence ideas have won 61% over n=31") and the auto-revert rule ("breaching the hourly cap automatically reverts to Propose"). Typed confirmation: `DECIDE ROTH IRA`. The boot-interlock consequence is stated at grant time: "If the server restarts, this account returns to HALTED until you re-arm (unless you opt into auto-resume — not recommended)."

### 4.3 Approving a live trade

1. Push notification → deep-link to the dossier (mobile or desktop).
2. Dossier renders stages 1–4 with the **live** gate pre-check (current drift vs `referencePrice`, cap headroom after this order, wash-lock check). If anything would block, the Approve button is replaced by the block explanation *before* the user invests intent.
3. Tap **Approve** → full-screen confirmation:
   ```
   ⬤ BROKERAGE — REAL MONEY
   BUY NVDA · market · estimated $481.12
   Account …4482 · Roth IRA
   This will place a real order. Type exactly:
   APPROVE LIVE NVDA
   [__________________________]      [Cancel]
   ```
   The estimated notional shown is the one the server will verify ±$0.01; if the fresh broker review re-prices it materially, the screen updates and the challenge re-arms.
4. On submit, the server re-runs everything (fresh scan, gate, CAS to `placing`). The UI narrates the states truthfully: "re-checking → placing (intent recorded, refId …8fa) → placed → filled 481.02". A double-tap or second session hits the CAS and gets "already decided by you at 12:44" — never a duplicate.
5. Failure honesty: `rejected_by_broker` shows the broker's synchronous decline verbatim; a lost response becomes a visible `pending_reconciliation` card ("we recorded the intent before calling the broker; reconciling by clientOrderId"), never a silent maybe.
6. The dossier appends stage 6 (execution) and begins accruing stage 7 (outcome).

### 4.4 Emergency stop

1. **HALT** in the Reality Bar (or press-and-hold on mobile) → an interstitial that does one job: prevent the classic panic error of expecting halt to *sell*.
   ```
   STOP — choose what kind of stop.
   ■ HALT — freeze everything. No orders of any kind,
     INCLUDING protective stop exits. Nothing is sold.
     Positions stay open and unguarded by this app.
     (Broker-held bracket stops keep resting at the broker.)
   ◨ CLOSE-ONLY — stop new buys. Exits and stops keep
     working. This is what circuit breakers choose.
   [ HALT roth ira ]        [ CLOSE-ONLY ]        [ Cancel ]
   ```
2. One confirm tap (deliberately *low* friction — emergencies get speed; it's un-halting that gets ritual). No typed text to halt.
3. State flips ≤ one scheduler tick; the ticker and an audit entry record actor + timestamp; in-flight run finishes its current isolation-protected step and stops queuing new orders; pending approvals are refused with "account halted."
4. The Reality Bar turns into a persistent HALTED banner with the two exit paths: [Resume (re-arm ritual)] [Move to Close-only]. The banner also lists what's now unguarded: "2 positions rely on synthetic stops which are paused; 3 have broker-held brackets which still rest."
5. Un-halting is the §4.2 arming ritual again. Asymmetric friction is the point.

### 4.5 Changing a risk limit on a live account

1. Risk & Policy → edit `stopLossPct` 8 → 12. Field shows default (8), current (8), pending (12) inline.
2. Sticky changeset bar → **Review & commit**: unified diff + **impact preview** computed against live positions ("NVDA stop moves 471.30 → 450.82; that's $61 more at risk on this lot") + required note (Brokerage only).
3. Because the account is `broker/live`, the commit button carries a word: type **`COMMIT`** (short — this is a guardrail *loosening*; a *tightening* commit needs no typed word; the UI computes direction per-field: widening stops, raising caps, enabling shorts = loosening).
4. Committed → Policy Ledger appends the diff, actor "you · web", the note, and a snapshot id; the change is live for the *next* gate evaluation; the ticker announces it.
5. If the tuner (or a mobile `policy.patch`) later touches the same field, the ledger shows both entries adjacently — config archaeology is a first-class feature, and every entry has [Revert this change ▸] which itself creates a new reviewed diff (never a silent restore).

### 4.6 Reviewing why the AI made a decision

Scenario: "Why did you buy NVDA last Tuesday?"

1. Ask the Assistant ("why did you buy NVDA?") → it calls its read tools and answers in prose *with a dossier link* — or go directly: Decisions → Ledger → filter NVDA → open dossier P-1847.
2. The dossier answers in layers, each one click deeper:
   - **The sentence** (stage 2 rationale) — what a novice needs.
   - **The evidence** (stage 1) — every input number with provider + asOf; the 8-K bulletin that fed the thesis links into the RAG source.
   - **The counter-argument** (stage 3) — the bear case verbatim, and the verdict. Nothing builds calibrated trust like reading the argument the machine had with itself.
   - **The law** (stage 4) — all 31 gate checks, and via the ledger backlink, *which policy version* was in force (the dossier pins policy-version and prompt-version ids).
   - **The alternative** — "rank 2 that run was AMD; [compare side by side]" from the run's full scored table.
   - **The consequence** (stages 6–8) — fill vs reference slippage, MAE/MFE ("dropped 3.1% below entry before recovering"), the exit linkage, and which scorecard cells this trade updated.
3. Every layer is permalinked; pasting a dossier URL into a note or email is the canonical way this product's decisions get discussed.

---

## 5. Settings taxonomy: what lives where, and how you can tell

The system's storage is tiered (account-scoped `account_strategy_state` vs user-scoped overlays vs deployment config). The UI makes scope *perceptible* rather than documented:

**Rule: every settings surface is visually stamped with its blast radius**, top-right, in words:

- 🞐 **THIS ACCOUNT — Roth IRA (Brokerage)** — trading policy (all caps, gates, riskRules, states, authority, cadence, universe), strategy prompt + weights, tax settings, per-account event notifications (`enabledEvents` + webhook), tuning knobs, `washSaleGuard`, `autoResumeOnBoot`. Header carries the account's reality chip; editing a Brokerage account's page tints the page edge.
- 🞑 **ALL YOUR ACCOUNTS (you)** — profiles library, notification channels (`NotifyPrefs`: push/webhook/email/SMS targets), scan shape (`marketScanCandidateLimit`, `outlierReserve`), watchlist, price alerts, chat history & memory, learned context, API keys, data-pool consent, account deletion. Sub-note where it bites: "Scan shape is yours, not the account's — it changes what every account's runs see."
- 🞒 **THIS DEPLOYMENT (operator)** — admin allowlist, budget monitor, provider ops, scheduler options. Only visible to operators; stamped "affects every user on this server."

Two cross-scope truths get explicit banners rather than relying on the stamp: the **wash-sale lockout** ("a loss in any taxable account locks buys of that symbol in ALL your accounts, including IRAs, for 30 days") wherever locks render; and **profile application** ("copies onto the account you choose; never changes its armed state").

The Simple/Full rulebook split (§3.7) is orthogonal to scope: Simple mode is a *lens* over the same account-scoped fields, never a separate store — editing in either mode feeds the same changeset and the same ledger.

---

## 6. Safety model: making dangerous states legible and errors hard

1. **Words as the last line.** Every irreversible or real-money action requires typing words that name the specific object (`APPROVE LIVE NVDA`, `ARM ROTH IRA`, `DECIDE ROTH IRA`, `DELETE MY ACCOUNT`). Typed challenges are keyboard-only on the live path. Generic confirm dialogs ("Are you sure? OK") are banned product-wide, so the typed ones stay meaningful.
2. **Asymmetric friction.** Stopping is one gesture; starting is a ritual. Tightening a limit is one commit; loosening one requires a typed word and a note. Rejecting is a swipe; approving never is. The friction gradient *is* the safety documentation.
3. **Reality is ambient, not modal.** The reality chip, state word, authority word, and spend odometer are in the chrome of every screen and every screenshot. Mode confusion — the deadliest error class in this product — is attacked by making the mode impossible to not see, and by the server's own mode-mismatch refusal surfacing as a first-class UI state ("this proposal belongs to a different account/mode — re-run the strategy").
4. **Dangerous states persist visually until resolved.** HALTED, CLOSE-ONLY (with cause: "set by daily-loss breaker at 11:58 ⧉"), reconciliation orphans, boot-interlock disarms, `placing_failed` — all render as standing banners/cards that only resolve through the correct flow, never through dismissal.
5. **Pre-flight over post-hoc error.** The dossier's live gate pre-check, the policy diff's impact preview, and the arming checklist all move failure *before* intent. When the server does refuse, the machine-readable `reasons[]` render verbatim, each mapped to the policy field that produced it, with a link to that field's control and history.
6. **The UI states the invariants it inherits, at the moment they matter.** "Halting never sells" on the halt screen; "exits are never blocked by caps" on the gate checklist (exit-exempt checks render as struck-through "exempt — exit"); "manual runs can only propose" on the run-once button; "missing broker capability = off" on the capabilities card; "unavailable red team routes to you" in the challenge stage. Users can't trust guarantees they've never been told.
7. **Learning is caged and shown caged.** Learned facts render as advisory text chips in the dossier's context stage — visually distinct from numeric inputs — with the caption "advisory only; never a number in sizing." Risk-tier facts queue for explicit approval. Weight changes appear only via the Learning ledger with clamps (±0.05/step) and OOS-gate verdicts shown, plus one-action ledgered revert; the shadow ledger gives a would-have-done trail before autonomy is trusted.
8. **Honesty about absence.** `n/a` vs `-` rendered distinctly everywhere; synthetic bid/ask flagged "synthetic — not a real spread"; benchmark/curves degrade to absent-with-a-sentence; delayed data wears its timestamps. A UI that never fakes small things earns belief for big ones.

---

## 7. What I would measure to know the design works

**Comprehension & trust (the lens's core):**
- **Reality-identification accuracy:** in-product micro-probe during onboarding and occasionally after ("which account was that action on, and was it real money?") — target ≥99% correct.
- **Dossier depth before decision:** % of approvals/rejections where the user expanded at least stages 1, 3, and 4 before deciding; median stages opened. Rising depth on live accounts, shallowing on Test, is the healthy signature.
- **"Why" resolution rate:** of sessions that open a dossier from a notification or the ledger, % that end without a follow-up support/chat question of the form "why…".
- **Counterfactual engagement:** weekly Shelf visits; correlation between Shelf exposure and rejection quality (do users who see their rejection scorecard converge toward the gate's hit rate?).

**Safety outcomes:**
- Zero mode-confusion incidents (live action believed to be Test/Paper) — the metric that must be zero.
- Typed-confirmation abort rate (started typing, then cancelled) — a healthy non-zero rate proves the ritual causes reconsideration; a very high rate signals upstream context failure.
- Proposal expiry rate on live accounts (target ≈0 — expiries mean the approval loop is losing the human), and time-to-decision from notification.
- Halt-then-what: after HALT, % of users who reach the intended follow-up state within 10 minutes without support; % who expected halt to sell (measured by an optional one-tap post-halt poll).
- Reconciliation queue dwell time; % of `placing_failed` resolved through the guided flow.

**Auditability in practice:**
- Policy Ledger usage: % of policy changes committed with meaningful notes; revert usage; % of loosening changes preceded by opening the relevant scorecard/impact preview.
- Time-to-reconstruct: a scripted quarterly task ("explain trade X's cause and outcome") timed for real users — target < 3 minutes to a correct verbal account.
- Provenance interaction rate on disputed numbers (chip hovers/opens following a support-reported data question).

**Product health:** Test→Paper→Brokerage progression funnel and rehearsal-skip rate; `decide`-grant rate *conditional on calibration n* (granting decide with n<20 closed trades is a design failure signal); notification channel test success; mobile command failure visibility (failed commands seen/acknowledged within 1h).

---

## 8. Top 10 design principles

1. **The lifecycle is the interface.** Navigation, objects, and pages mirror signal → thesis → challenge → gate → approval → execution → outcome → learning. If a screen can't say which station it is, it doesn't ship.
2. **Every fact wears its passport.** Provider, timestamp, and computed-vs-absent status render at the point of use. `n/a` and `-` are different words for different truths and are never conflated.
3. **Reality in words, everywhere, always.** Test / Paper / Brokerage as unhideable word chips in the chrome; typed phrases—not clicks—stand between intent and real money.
4. **Asymmetric friction: stopping is instant, starting is a ritual.** Halt in one gesture; arm, decide, and loosen only through checklists, diffs, notes, and typed names.
5. **Configuration is law: versioned, diffed, annotated, revertible.** No silent saves. Every change—human, mobile, tuner, breaker—is a ledger entry you can diff and revert through the same reviewed path.
6. **Show the argument, not just the answer.** The bear case, the gate's itemized verdicts, the skipped rank-2 candidate, and the do-nothing decision are rendered, because trust is built on visible dissent and visible restraint.
7. **The roads not taken are part of the record.** Rejected, blocked, withdrawn, and skipped ideas keep score in the open—including when the human was wrong and when the cage was right.
8. **Absence is information; never fabricate, never extrapolate.** Missing data renders as absent with a reason. A UI honest about small gaps is believed about big claims.
9. **Pre-flight beats post-hoc.** Live gate pre-checks, impact previews, and arming checklists move failure before intent; server refusals arrive as mapped, actionable reasons, not error toasts.
10. **State the guarantee at the moment it matters.** Every inherited invariant—halting never sells, exits are sacred, manual runs only propose, learning is advisory-only—is written on the control that embodies it, in one sentence, in plain words.

---

*— End of design. Word count ≈ 6,300.*
