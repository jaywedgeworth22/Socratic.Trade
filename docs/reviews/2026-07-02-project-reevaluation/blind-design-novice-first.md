# Steadyhand — a Novice-First Interface for an Agentic Trading System

*A blind, bottom-up product design derived only from the capability inventory. Lens: a first-time retail user who has never used a trading tool, is nervous about real money, and is delegating trading decisions to an AI for the first time. The safe path must be the default path; the dangerous path must be unmistakable.*

---

## 0. Design stance and vocabulary

The system underneath is enormous: ~50 policy fields, an adversarial LLM debate, counterfactual analytics, wash-sale law, walk-forward statistical gates. The novice needs almost none of that on day one. They need permanent, glanceable answers to three questions the inventory itself names:

1. **Is this real money?**
2. **Is the agent armed?**
3. **What can it spend?**

Everything in this design radiates from those three questions. The expert machinery is all still reachable — via progressive disclosure ("Show advanced"), never via a separate "expert app."

### The vocabulary layer

The server speaks in field names (`systemState`, `strategyAuthority`, `close_only`). The UI speaks in plain words, mapped one-to-one and shown *with* the technical term in tooltips so power users and support conversations never diverge:

| Server concept | UI word | One-line explanation shown in UI |
|---|---|---|
| `test/local` mode | **Test** | "Play money. Simulated by this app, marked to live prices. No broker involved." |
| `broker/paper` mode | **Paper** | "Your broker's practice sandbox. Real broker, zero real dollars." |
| `broker/live` mode | **Brokerage** | "REAL MONEY. Orders here can spend your actual cash." |
| `strategyAuthority: propose` | **Ask-first** | "The AI suggests trades. Nothing happens until you approve each one." |
| `strategyAuthority: decide` | **Autopilot** | "The AI can place trades itself, inside your guardrails." |
| `systemState: active` | **Running** | "The strategy runs on its schedule." |
| `systemState: halted` | **Frozen** | "Everything stops — no buys, no sells, not even protective exits. Nothing is sold." |
| `systemState: close_only` | **Exit-only** | "No new buys. Protective sells still work." |
| `systemState: liquidating` | **Winding down** | "Only sell orders, until the account is flat." |
| `proposed` proposal | **Waiting for you** | — |
| Red Team review | **Devil's advocate** | "A second AI tried to talk this trade down. Here's its argument." |
| Counterfactual return | **What happened after you said no** | — |

Rule: **the word always appears; color and icon are reinforcement, never the only signal.** This matches the inventory's "word-first money-reality" invariant and is non-negotiable for accessibility.

---

## 1. Information architecture & navigation model

Seven top-level destinations for everyone, plus one that appears only for admins. Left rail on desktop, bottom tab bar (5 tabs + "More") on mobile.

1. **Home** — "What is my money doing right now?" The monitoring surface: reality/armed/spend answers, portfolio value, equity curve, today's activity, next scheduled run, active guardrail status, circuit-breaker state. This is the screen a nervous user opens six times a day; it must answer everything without a click.
2. **Approvals** *(badge: count of `proposed` items)* — the human-in-the-loop inbox. Every trade "waiting for you," each as a decision card with rationale, dollar amount, thesis tag, devil's-advocate summary, performance-since-proposed, and expiry countdown. Also hosts the **Learning approvals** sub-tab (pending `LearnedContextPendingRow` items and tuning proposals) — anything the machine wants a human to bless lives in one inbox, because a novice should have exactly one place to check for "the robot needs me."
3. **Activity** — the append-only story: runs (with summaries and counts), fills, blocked orders with reasons, withdrawn/expired proposals, notifications sent, audit events. Chronological feed with filters. Answers "what happened while I was asleep?" Every row links to a **Decision Receipt** (§3.6-flow).
4. **Results** — performance and tax. Equity curve vs. SPY, live vs. paper buckets, win rates, thesis/regime scorecards (behind "Show advanced"), the counterfactual "ones you said no to" board, and the full **Tax** tab (realized gains, wash-sale lockouts, days-to-long-term countdowns, harvest candidates, estimated liability).
5. **Strategy** — everything that configures *how this account trades*: the Guardrails card (the novice's whole world), the strategy prompt, universe, schedule/cadence, authority level, protective-exit settings, the preset library (Strategy Profiles), and — behind advanced disclosure — the full ~50-field policy and `tuning.*` knobs. **Strategy is always account-scoped and visibly so** (§5).
6. **Ask** — the chat assistant. Grounded Q&A ("why did you buy NVDA?", "what's my P&L?"), draft-order creation ("buy $50 of AAPL" → draft ticket → promotes into the same Approvals rail), price-alert creation, watchlist edits. Chat is the novice's escape hatch from every screen: a persistent "Ask about this" affordance deep-links context into chat.
7. **Settings** — user-global things: connected accounts management (connect broker, Graduation Ladder), notification channels (push/email/SMS/webhook + test button), API keys & provider health, data-sharing consent, chat memory, account deletion.
8. **Admin** *(visible only to allowlisted emails)* — usage & cost ledgers, provider health, content-pipeline operations, ops snapshot token, test emitters.

**Why this shape:** Novices navigate by *task-verb* ("check", "approve", "see what happened", "see if I'm winning", "change how it trades", "ask a question", "set up"), not by domain noun ("policies", "runs", "proposals"). Each tab is one verb. Approvals gets its own top-level slot — even though it could nest under Activity — because it is the single most consequential recurring interaction and carries the app's only red badge. Alerts and watchlist deliberately do *not* get a top-level tab: they live inside Home (a "Watching" panel) and via Ask, because for a delegator they're peripheral.

---

## 2. The global frame (chrome)

Always visible, on every screen, both platforms:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ⣿ REALITY RIBBON ─ "TEST · play money"  |  Roth IRA – Alpaca Paper ▾  |     │
│    [● Running · Ask-first ▾]      $10,412.88  ▲ +1.2% today   🔔3  [ FREEZE ]│
├─────────────────────────────────────────────────────────────────────────────┤
│  (nav rail)  │                    screen content                            │
│  Home        │                                                              │
│  Approvals ❷ │                                                              │
│  Activity    │                                                              │
│  Results     │                                                              │
│  Strategy    │                                                              │
│  Ask         │                                                              │
│  Settings    │                                                              │
├──────────────┴──────────────────────────────────────────────────────────────┤
│ Data as of 2:41 PM (quotes delayed ~15 min) · Next scheduled run in 22 min  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 The Reality Ribbon (money-reality)

A full-width strip at the very top of the viewport, containing the **mode word in text**, a clarifying phrase, and the mode color:

- **TEST** — teal ribbon: `TEST · play money — simulated by this app`
- **PAPER** — indigo ribbon: `PAPER · broker sandbox — no real dollars`
- **BROKERAGE** — deep crimson ribbon **plus a persistent 3px crimson border around the entire viewport**: `BROKERAGE · REAL MONEY`

The red frame in Brokerage mode is deliberate ambient chrome: peripheral vision knows you're in the real-money room even when you're staring at a chart. It never appears in Test/Paper, so it can never be normalized away. The ribbon is drawn from the server's derived `deriveExecutionState` — never inferred client-side.

### 2.2 The Account Scope Pill

`Roth IRA – Alpaca Paper ▾` — the active account's label + broker + environment. Clicking opens the account switcher, where **every account row repeats its own mode word and color chip** so you can never switch into real money without reading the word "Brokerage." Switching accounts swaps the ribbon, the armed chip, the balances — the whole app rescopes, with a 600ms full-screen "Now viewing: **Personal – Robinhood BROKERAGE (REAL MONEY)**" interstitial when the destination is a live account.

### 2.3 The Armed Chip (agent state)

`● Running · Ask-first` — a two-word compound of `systemState` + `strategyAuthority`. States render as:

- `● Running · Ask-first` (green dot) — the safe default
- `● Running · AUTOPILOT` (pulsing amber dot; crimson if Brokerage) — autonomy is on
- `❚❚ Frozen` (gray) — halted
- `▼ Exit-only` (amber) — set by user or **by a circuit breaker** — when breaker-set, the chip carries a small ⚡ and tapping it explains which breaker tripped and when
- `▽ Winding down` (amber)

Tapping the chip opens the **Control Sheet** — the single place run-state is changed (§4.4).

### 2.4 The Spend Line

Directly under the balance on Home, and inside the Armed Chip popover everywhere: *"Today the AI may still spend up to **$212 of $500**"* — the live remaining daily notional (and per-order cap) rendered as a partially-filled meter. This is the third of the three sacred questions, always one glance away.

### 2.5 FREEZE

A bordered, octagon-iconed button, top-right, on every screen, both platforms — the emergency control. It never fires immediately; it opens the Emergency Sheet (§4.4) which explains in one sentence per option what Freeze / Exit-only / Wind-down actually do — critically, that **Freeze sells nothing and also stops protective exits**. Novices must never discover that nuance during a panic.

### 2.6 The Freshness Footer

`Data as of 2:41 PM (quotes delayed ~15 min) · Next run in 22 min`. The inventory says quotes are delayed and freshness is ~1-minute-granular; the UI promises exactly that and no more. Timestamps everywhere; the word "real-time" appears nowhere in this product.

---

## 3. Screen-by-screen designs

### 3.1 First-run (guided onboarding)

Runs entirely in **Test** mode — connecting a broker is not even offered until the tour completes. Five steps, ~4 minutes:

**Step 1 — "Meet your money."** Creates the Test account: *"We've given you **$10,000 of play money**. It trades against real live prices, but it is not connected to any broker and cannot spend a real cent. You can stay in Test forever — it's free."* (Amount editable.)

**Step 2 — "Set your guardrails."** Three sliders with safe defaults, rendered as an editable English sentence (the **Guardrail Sentence**, §3.5): *"The AI may spend at most **$100 per trade** and **$500 per day**, sell automatically if a position drops **8%**, and suggest at most **3 ideas per run**."* Below: "There are about 50 more dials under the hood, all set to safe defaults. You never have to touch them."

**Step 3 — "Choose how much control it gets."** Two large cards: **Ask-first** (pre-selected, badge "Recommended — most people stay here") vs. **Autopilot** (card is *visibly disabled* with the note: "Unlocked after your first 3 approvals — you should see how it thinks before letting it act alone").

**Step 4 — The Fire Drill.** *"Before anything runs, practice stopping it."* The user must actually press **FREEZE**, see the Emergency Sheet, read the one-line explanations, choose Freeze, watch the Armed Chip flip to `❚❚ Frozen`, then un-freeze. A design conviction: the first time someone uses the emergency brake must not be an emergency. (The app schedules a repeat drill after 30 days in Test.)

**Step 5 — "Run it once."** A manual run-once fires (which the platform forces to Ask-first anyway). The user watches a live progress trace — *scanning 500 names → scoring → asking the strategist → devil's advocate reviewing → checking your guardrails* — and lands on their first Approval card. First-run ends with the user making their first real decision, on fake money, within minutes.

A dismissible **Graduation Ladder** card then lives at the top of Home (§4.2).

### 3.2 Home

```
┌──────────────────────────────────────────────────────────────────┐
│  $10,412.88   ▲ +$122.40 (+1.2%) today        [Test · play money]│
│  Today the AI may still spend  ▓▓▓▓▓▓░░░░  $212 of $500          │
│──────────────────────────────────────────────────────────────────│
│  ▸ GRADUATION LADDER   Test ✅ → Paper ▢ → Brokerage 🔒   [view] │
│──────────────────────────────────────────────────────────────────│
│  NEEDS YOU (2)                                                   │
│  ┌──────────────────────────┐ ┌──────────────────────────┐       │
│  │ Buy $84 of NVDA          │ │ Sell ½ of AAPL (take     │       │
│  │ Momentum-Breakout        │ │ profit)   expires 41h    │       │
│  │ expires in 46h  [Review] │ │           [Review]       │       │
│  └──────────────────────────┘ └──────────────────────────┘       │
│──────────────────────────────────────────────────────────────────│
│  YOUR MONEY (equity curve, 1W/1M/3M/1Y, vs SPY toggle)           │
│  ~~~~~~~~~~~~~~~~/\/~~~~~~                                       │
│──────────────────────────────────────────────────────────────────│
│  POSITIONS (4)                         WATCHING (3 alerts armed) │
│  NVDA  12 sh  +6.2%  🛡 stop −8%       AAPL < $200  armed        │
│  ...                                   ...                       │
│──────────────────────────────────────────────────────────────────│
│  LAST RUN — 2:00 PM: "Scanned 512 names, proposed 2, blocked 1   │
│  (daily cap), did nothing else on purpose."      [Full story →]  │
│  NEXT RUN — 3:00 PM (market open, cadence 60 min)                │
└──────────────────────────────────────────────────────────────────┘
```

Design notes:
- **"Did nothing on purpose" is a first-class positive state.** When the do-nothing gate or score floor filters everything out, the run summary says so proudly. Novices equate silence with breakage; the UI must equate deliberate inaction with discipline.
- Each position shows a tiny 🛡 with its live protection (stop %, trailing, broker-held bracket) — protection is visible, not implied.
- If a circuit breaker or panic brake has fired, the entire top of Home is replaced by an amber **Breaker Banner**: *"⚡ Exit-only since 1:14 PM — your account was down 6% today, past your 5% daily-loss limit. No new buys will happen. Protective sells still work. [What happened] [Resume when ready]"*

### 3.3 Approvals (the decision inbox)

Two sub-tabs: **Trades** and **Learning**.

**Trades** — one card per `proposed` item, full-width, one at a time on mobile (deck), list+detail on desktop:

```
┌────────────────────────────────────────────────────────────────────┐
│  BUY  ~$84  NVDA · NVIDIA Corp             [Test · play money]     │
│  Thesis: Momentum-Breakout      Confidence: 82/100                 │
│  Regime at proposal: Risk-on / expansion                           │
│────────────────────────────────────────────────────────────────────│
│  WHY (the strategist):                                             │
│  "Breaking out of a 3-week base on 2× average volume; sector       │
│   leading; analyst targets 18% above price."                       │
│                                                                    │
│  DEVIL'S ADVOCATE said: "Earnings in 6 days — gap risk. Entry is   │
│  extended vs. 20-day average."  → survived review                  │
│                                                                    │
│  Since proposed (3h ago): NVDA is  ▲ +0.8%  vs. its $874.20 anchor │
│────────────────────────────────────────────────────────────────────│
│  IF YOU APPROVE: buy ~$84 at market (est. 0.096 sh). A stop-loss   │
│  at −8% and take-profit at +20% will protect it automatically.     │
│  IF YOU DO NOTHING: this expires in 46 h and nothing is bought.    │
│  Your guardrails: passes all 14 checks ✅   [see checks]           │
│────────────────────────────────────────────────────────────────────│
│  [ Reject ]                [ Ask about this ]        [ Approve ✓ ] │
└────────────────────────────────────────────────────────────────────┘
```

- **The three-outcomes block** ("if you approve / if you do nothing / guardrail status") is the heart of the card. Doing nothing is always an explicitly described, legitimate choice with a countdown — the safe default has a face.
- Approve on Test/Paper: one tap + toast. Approve on **Brokerage: the typed challenge** (§4.3).
- Reject asks one optional low-friction question — "Why? (helps it learn)" with chips: *Too risky / Don't like this stock / Too big / Bad timing / Just no* — and tells the user: *"We'll keep watching this idea and show you how it does."* Rejection feeds the counterfactual board; the UI frames saying no as data, not failure.
- Stale cards (proposal re-validated with `revalidationNote`, or withdrawn) update in place via SSE: a withdrawn card collapses to a gray stub — *"The strategist took this one back: 'catalyst passed.'"*

**Learning** — pending learned-context facts and tuning proposals, same card grammar: WHAT it wants to remember/change, WHY, WHAT CHANGES IF YOU APPROVE ("advisory note only — never changes your limits"), and for weight changes: the ±0.05 clamp, the out-of-sample validation verdict, and a "revert anytime from Activity" promise.

### 3.4 Activity

A reverse-chronological feed, filter chips across the top (`Runs · Fills · Blocked · Approvals · Alerts · System · Learning`). Every run row expands into the **Run Story**:

```
Run · 2:00 PM · completed · 512 scanned → 6 shortlisted → 2 proposed, 1 blocked
├─ Snapshot before: $10,388  ·  after: $10,412
├─ Breakers checked: drawdown ok · daily loss ok · volatility ok
├─ Protective exits: none needed
├─ Chosen: NVDA (82), AAPL trim (74)   Skipped near-misses: MSFT (71), AMD (68) →
├─ Blocked: TSLA — "would exceed your $500 daily cap ($468 already used)"
└─ [Open any item → Decision Receipt]
```

System rows include boot events in plain words: *"App restarted, so Autopilot was switched off for safety. It stays off until you turn it back on."* (the boot interlock, made legible). Learning rows show applied weight changes with one-action **Revert**.

### 3.5 Strategy (configuration)

Scoped to the account in the Scope Pill; the page header repeats it: **"Strategy for: Roth IRA – Alpaca Paper"** with the mode chip. Sections, top to bottom:

1. **Guardrails** — the star of the page. A card that renders the whole safety envelope as the **Guardrail Sentence**, each bolded value tappable to a slider:
   > "The AI may spend at most **$100 per trade** and **$500 per day**, hold at most **25%** in any one stock, sell automatically at **−8%**, take profit at **+20%** (selling **half**), and stop all new buys if the account falls **10%** from its peak or loses **$300 in a day**."

   Under it: `[Show all 50 dials]` → the full grouped policy editor (order caps, exposure caps, entry-quality gates, stops plumbing, shorts, tuning). Every advanced field has the safe default marked and a "Reset to safe" affordance. Short-selling and Autopilot-adjacent toggles carry an inline "this increases risk" ledger line. On a **Brokerage** account, every guardrail change goes through Review-and-Type (§4.5).
2. **Schedule & control** — cadence, extended hours, run-once button, and the same Control Sheet the Armed Chip opens.
3. **Authority** — Ask-first vs. Autopilot cards (Autopilot gated as in §4.2).
4. **Universe** — index checklist (S&P 500 etc.), always-include and never-touch (blocklist) symbol lists, floor filters behind advanced. Copy notes: *"Blocking a stock never blocks selling it — exits are always allowed."*
5. **Strategy prompt** — the free-text brief, with the shipped default visible and a "restore default" control. Framed as "The strategist's written instructions."
6. **Presets library** — Strategy Profiles: save current setup as preset; apply preset to *chosen* account via a picker that repeats the target's mode word. Copy under Apply: *"Copies settings onto the account. Never turns the AI on or off, never touches Frozen/Running state."*
7. **Learning & tuning** (advanced, default collapsed) — reflection summaries, scorecards links, autonomous-tuning opt-ins with their statistical gates explained in one line each, shadow-ledger view.

### 3.6 Results

Sub-tabs: **Performance · Ideas ledger · Tax**.

- **Performance:** equity curve vs. SPY (normalized, "excess return" callout), realized/unrealized P&L, win rate, avg return — all bucketed with a Test+Paper vs. Brokerage toggle that repeats the mode words. If tax netting is on, a toggle "after estimated tax." Anything uncomputable renders as `—` with "not enough history yet," never a fabricated number. Advanced disclosure: thesis scorecard, regime × thesis matrix, factor IC, confidence calibration ("when it says 80, it's right 61% of the time"), MAE/MFE.
- **Ideas ledger — "The ones you said no to."** Every rejected/blocked/skipped idea with its performance-since-decision:

  ```
  You rejected 14 ideas in 90 days.
  If approved, they'd have returned +2.1% avg · your approvals returned +3.4% avg
  ✅ Your judgment is adding value.
  MSFT (rejected 6/2)  +4.2% since   |  TSLA (blocked, cap)  −1.8% since
  ```

  This is trust-calibration infrastructure: it tells the novice honestly whether their vetoes help or hurt, and it normalizes the fact that the system keeps score of *everything*, including restraint.
- **Tax:** headline "Estimated tax set aside for this year: **$412**" (with "estimates, not tax advice" line); realized ST/LT split; **wash-sale lockouts** as pill list ("NVDA locked until Jul 28 — buying it again would forfeit a $120 loss deduction"); **almost-long-term countdowns** ("AAPL: 22 days to long-term — selling now costs an extra ~$31 in tax"); harvest candidates. IRA accounts replace this tab with "This is an IRA — no yearly taxes on trades here."

### 3.7 Ask (chat)

Standard thread UI with grounding chips under each answer ("from your positions", "from run 2:00 PM", "from the 10-K"). Composer suggestions rotate: *"Why did you buy NVDA?" · "What's my P&L this month?" · "Alert me if AAPL drops below 200."*

The critical design point: **chat cannot trade.** When a user types "buy $50 of Apple," chat produces a **Draft ticket** card — visually a dashed-border, gray "not real yet" object — with a `[Send to Approvals]` button. Promotion converts it into a normal proposal on the normal rail, subject to the same gates, same typed challenge if live. Microcopy on the draft: *"Chat can draft, never trade. This goes through the same safety checks as everything else."*

### 3.8 Alerts & Watching

Lives as the "Watching" panel on Home plus full management via Ask and a modest Settings sub-page. Price alert rows: `AAPL < $200 · armed · note: "add if it dips"` → when triggered, becomes a notification event and a Home badge. Creation is chat-first (natural language is genuinely the best input for alerts) with a structured fallback form.

### 3.9 Settings

- **Accounts** — connected accounts list (each row: label, broker, **mode word chip**, capabilities badges like "shorting allowed by broker," active toggle "exactly one active"), `[+ Connect broker]` → Graduation Ladder (§4.2), per-account deletion, encrypted-at-rest note.
- **Notifications** — channel cards (Phone push / Email / SMS / Webhook), each showing configured target and a `[Send test]`; a per-event matrix (fills, blocks, needs-approval, circuit breaker, price alerts, budget) with novice-safe defaults pre-checked (needs-approval, circuit breaker, fills ON).
- **Data & API keys** — per-provider key entry with health dots and "what this unlocks" copy; the data-pool consent toggle with a plain explanation of reciprocity.
- **Assistant memory** — list of remembered facts/preferences with delete.
- **Privacy & account** — export, and the two-step typed deletion (`DELETE MY ACCOUNT`) with the preview-of-what-dies and blockers surfaced ("finish or cancel 1 in-flight order first").

### 3.10 Admin (allowlist-only)

A deliberately utilitarian console, separate visual skin (dense, monochrome) so it never gets confused with the consumer surface: **Usage & cost** (per-user LLM/RAG spend, operator-funded flag, budget thresholds), **Provider health** (per-service, per-credential-lane status, consecutive-failure alarms, error clusters), **Pipelines** (re-index filings, refresh web sources, import securities, probe broker), **Dry runs** (tuner dry-run, factor-IC backtest, congress gate eval), **Ops** (scheduler heartbeat, snapshot token, test emitters). Every destructive/pipeline action logs to the audit feed.

### 3.11 Mobile

Mobile is the **command-and-consent remote**, not a shrunken desktop. Bottom tabs: `Home · Approvals · Ask · Activity · More`. The Reality Ribbon compresses to a colored status-bar-adjacent strip with the mode word; the red viewport frame persists in Brokerage. FREEZE lives in the top-right of every screen.

- Approvals is the deck UI; **no swipe gestures for approve/reject** — deliberate button taps only. Muscle-memory swiping is how mistakes happen with money.
- Push notification taps deep-link straight into the relevant card ("NVDA proposal needs you — expires in 46h").
- Commands ride the durable queue: every action shows `queued → running → done` states with the honest microcopy "sending to your strategist…" — the platform is a 60-second-tick system and the UI embraces observable-async rather than faking instant.
- The typed live-approval challenge works identically on mobile (full-screen sheet, keyboard up, no autofill).
- Secrets never on the phone; broker connection flows hand off to desktop or in-app OAuth only.

---

## 4. The six highest-stakes flows

### 4.1 First run with fake money
Covered in §3.1. Key beats: Test account auto-provisioned → Guardrail Sentence with defaults → Ask-first locked in → **Fire Drill (mandatory FREEZE practice)** → manual run-once with live pipeline trace → first approval decision on play money. Time-to-first-decision target: under 5 minutes. No broker, no keys, no payment anywhere in the flow.

### 4.2 Arming real money (the Graduation Ladder)

Real money is a **level you climb to, not a toggle you flip**. The ladder card (Home + Settings→Accounts) shows three rungs with earned checkmarks:

**Rung 1 → Paper.** Gate: completed first-run + ≥3 approval decisions in Test. Flow: pick broker (Alpaca keys / Robinhood OAuth) → connect *paper* environment → capabilities snapshot shown ("Your broker allows: stocks ✓, shorting ✗, options ✗ — we only ever do what your broker confirms") → new account starts **Frozen** with guardrails copied from Test.

**Rung 2 → Brokerage (Ask-first).** Gate checklist, all visible ahead of time: 2+ weeks on Paper · ≥10 decisions made · Fire Drill completed · notifications channel verified (test push received) · broker reports the account `agenticAllowed`. Then the **arming ceremony**:
1. Full-screen sheet, crimson: "You are about to connect the AI to **REAL MONEY** — account ****4821."
2. **The worst-case paragraph**, computed live from the actual guardrails: *"In the worst day your settings allow, the AI could ask you to spend up to **$500**, and a market crash could cost roughly **$X** before stops fire. Stops are protections, not guarantees."*
3. The Guardrail Sentence, re-shown for confirmation with an `[adjust first]` link.
4. Typed phrase: **`ARM REAL MONEY 4821`**.
5. Account arms into **Running · Ask-first**. Autopilot is *not* offered here.

**Rung 3 → Autopilot on Brokerage** (separate, later ceremony): requires ≥20 approvals on this account with a shown approval-rate readout ("you approved 84% of its live ideas — it seems aligned with you"), a **24-hour cooling-off timer** started at request and confirmed after, the worst-case paragraph again (now framed as "without asking you first"), and a typed **`ENABLE AUTOPILOT 4821`**. The UI also states the standing safety facts: *"It still cannot exceed any guardrail. High-stakes ideas still come to you when its devil's advocate can't review. If the app restarts, Autopilot switches itself off until you re-enable it."*

### 4.3 Approving a live trade (typed confirmation)

1. Card reviewed in Approvals; on a Brokerage account the Approve button reads **`Approve with real money…`** and is styled crimson-outline.
2. Tapping opens the **Live Approval Sheet** (server-driven from the `LIVE_CONFIRMATION_REQUIRED` contract):
   ```
   ┌──────────────── REAL MONEY APPROVAL ────────────────┐
   │  BUY NVDA — estimated $84.12 from account ****4821  │
   │  Re-checked just now: price moved +0.3% since       │
   │  proposal (within your 10% drift limit) ✅           │
   │  All guardrails re-passed ✅                         │
   │                                                     │
   │  Type exactly:  APPROVE LIVE NVDA                   │
   │  [__________________________]  (paste disabled)     │
   │                                                     │
   │  [ Cancel ]                    [ Place order ]      │
   └─────────────────────────────────────────────────────┘
   ```
3. The estimated notional shown *is* the value the server verifies (±$0.01); if the fresh re-review changed the estimate, the sheet updates and says so before the user types.
4. On mismatch/expiry/withdrawal mid-approval, the sheet degrades gracefully with the server's reasons ("this idea expired while you were reviewing — nothing was placed").
5. Success → order chip flips `placing → placed → filled` live via SSE; a push notification confirms the fill. Double-taps are impossible by design (server CAS) and by UI (button disables on submit).

### 4.4 Emergency stop

FREEZE (always visible) → the **Emergency Sheet**, one screen, three verbs, radio-style — with the non-obvious consequences stated *before* selection:

```
┌──────────────── STOP THE STRATEGY ────────────────┐
│ ◉ FREEZE EVERYTHING                               │
│   Nothing buys, nothing sells — not even your     │
│   automatic stop-losses. Your positions stay      │
│   exactly as they are. Broker-held stops (if any) │
│   still protect you at the broker.                │
│                                                   │
│ ○ EXIT-ONLY                                       │
│   No new buys. Protective selling keeps working.  │
│   (This is what the automatic circuit breakers    │
│   choose.)                                        │
│                                                   │
│ ○ WIND DOWN                                       │
│   The AI sells positions until the account is in  │
│   cash. This SELLS things. It may realize losses  │
│   and taxes.                                      │
│                                                   │
│           [ Cancel ]        [ Confirm: FREEZE ]   │
└───────────────────────────────────────────────────┘
```

- One tap + one confirm; **no typing** — emergencies must be fast. (Typing gates *risk-increasing* acts; stopping is risk-reducing and must be cheap.)
- Applies to the scoped account; a `[stop ALL my accounts]` link at the bottom for multi-account users.
- Afterward Home shows the persistent state banner with a `[Resume]` path that, on Brokerage, re-runs the arming confirmation (resume is risk-increasing, so it costs friction; stopping never does).
- Wind-down uniquely requires a typed `WIND DOWN 4821` on Brokerage — it's the one "emergency" verb that sells.

### 4.5 Changing a risk limit on a live account

1. Strategy → Guardrails on a Brokerage-scoped account. Every value shows a small crimson underline: "changes here affect real money."
2. User drags "per day" from $500 → $2,000.
3. **Change Review panel** slides in before anything saves:
   ```
   You're changing: Max spend per day
        $500  →  $2,000        (4× looser)
   Direction: ⚠ LOOSER — the AI can spend more
   Worst-case day changes from $500 to $2,000.
   This takes effect on the next run (~22 min).
   Type CHANGE LIMIT to confirm.
   ```
4. Risk-*tightening* changes (lowering caps, raising stops) skip typing — one confirm click, because the safe direction must always be the easy direction. The looser/tighter classification is computed per field.
5. Saved changes log to Activity ("You raised the daily cap $500→$2,000 at 2:14 PM") and, if a notification channel is on, echo to the phone — self-notification is a tamper/typo alarm.
6. On Test/Paper: sliders save instantly, no ceremony. Friction is proportional to reality.

### 4.6 Reviewing why the AI made a decision (the Decision Receipt)

Every proposal, fill, block, and skip opens the same standardized artifact — reachable from Approvals, Activity, Positions, Results, or by asking chat "why did you buy NVDA?" (chat answers in prose *and* links the receipt):

```
┌──────────── DECISION RECEIPT · BUY NVDA · Jun 30, 2:00 PM ────────────┐
│ 1 THE SHORT VERSION                                                   │
│   "Bought ~$84 of NVDA on a momentum breakout; devil's advocate       │
│    flagged earnings risk but the idea survived; all 14 guardrail      │
│    checks passed; you approved it at 2:31 PM."                        │
│ 2 WHAT IT SAW  (evidence, each line with source + timestamp)          │
│   · Price $874.20 (broker quote, 1:59 PM)                             │
│   · +38% 3-mo momentum (score 91) · Sector strength #2/11             │
│   · Analyst mean target +18% (3 providers)  · News sentiment +0.6     │
│   · Regime: Risk-on / expansion                                       │
│ 3 THE DEBATE                                                          │
│   Strategist (confidence 82): full argument ▸                         │
│   Devil's advocate: "earnings in 6 days…" — verdict: not fatal ▸      │
│ 4 THE RULES CHECK  — 14/14 passed (each named, each with its number:  │
│   "order $84 ≤ $100 per-trade cap ✓ · day $296+$84 ≤ $500 ✓ · …") ▸   │
│ 5 THE SIZE  — "confidence 82 → 3.1% of portfolio, capped by           │
│   corroboration rule to 2.4% → $84" ▸                                 │
│ 6 WHAT HAPPENED SINCE  — filled $84.03 · now +2.1% · stop armed −8%   │
│ 7 THE ONES IT DIDN'T PICK — MSFT 71, AMD 68 … [and how they've done]  │
└───────────────────────────────────────────────────────────────────────┘
```

Layer 1 is written for the novice; layers 2–7 progressively disclose the full `signal_snapshot`, factor breakdown, per-field provenance ("P/E from Yahoo Finance"), gate-by-gate arithmetic, and the skipped-candidate counterfactuals. For a **blocked** order, section 4 leads with the failed check in red and the receipt title becomes "why NOT." The receipt is the single trust artifact of the product: identical grammar whether the outcome was buy, sell, block, or skip.

---

## 5. Settings taxonomy — per-account vs. global, and how users feel it

**Per-account (lives in Strategy, always under the account's name and mode chip):** guardrails/policy (all ~50 fields), strategy prompt, scoring weights, universe, cadence/schedule, authority (Ask-first/Autopilot), run-state, protective-exit plumbing, short-selling, tax settings (`taxationType`, wash-sale guard, rates, net-of-tax display), per-account event webhooks, tuning knobs. **Perception device:** the Strategy page is visually *inside* an account-colored frame whose header names the account; switching the Scope Pill visibly swaps the entire page contents with a crossfade, teaching "these dials belong to *this* account."

**User-global (lives in Settings, marked with a small 🌐 "applies to all your accounts" tag):** notification channels & targets, price alerts & watchlist, API keys & provider config, data-pool consent, chat history & memory, the presets library, scan-shape fields (`marketScanCandidateLimit`, outlier reserve — shown under Settings→Data as "how wide the market scan looks, for all accounts"), profile & deletion.

**The bridging object is the preset.** Presets are global (library) but *apply* per-account by copy. The Apply dialog makes copy-semantics explicit: *"This copies today's version of 'Cautious Swing' onto **Personal – Robinhood BROKERAGE**. Future edits to the preset won't touch the account. Running/Frozen state is never changed by a preset."* Applied accounts show a provenance chip ("based on 'Cautious Swing', modified since").

Two cross-cutting rules keep the model honest: (1) anything that can spend money is per-account and lives behind the account-framed page; (2) anything about *you* (identity, phone, keys, consent) is global and lives in Settings. The wash-sale lockout is the one deliberate exception — it's a *cross-account* consequence, and both the Tax tab and any blocked buy say so explicitly: "locked because of a loss you realized in your *other* account."

---

## 6. Safety model — making danger legible and error hard

1. **Reality is ambient and word-first.** Ribbon + word + color + crimson viewport frame; every proposal/fill/receipt is stamped with its mode word; the switcher interstitial announces entry into Brokerage. Color-blind-safe because the word is always present.
2. **Friction is proportional to irreversibility, and asymmetric by direction.** Stopping, tightening, rejecting: one tap. Starting, loosening, approving-live, arming, winding down: typed phrases, worst-case paragraphs, cooling-off timers. The user learns the grammar quickly: *if it's easy, it's safe; if I'm typing, real money is at stake.*
3. **Typed phrases are semantic, not CAPTCHA.** `APPROVE LIVE NVDA`, `ARM REAL MONEY 4821`, `CHANGE LIMIT`, `WIND DOWN 4821`, `DELETE MY ACCOUNT` — each phrase contains the object of consent, paste-disabled, so the fingers must pass through the meaning.
4. **The emergency path is rehearsed and fast.** Mandatory Fire Drill at onboarding; FREEZE on every screen; no typing to stop; consequences ("freezing sells nothing, and pauses automatic stop-losses too") explained *inside* the emergency sheet at the moment of choice, with broker-held-bracket reassurance where applicable.
5. **Automatic protections are visible before they fire.** Guardrail meters on Home (daily spend), 🛡 per position, breaker thresholds shown in the Guardrail Sentence; when a breaker fires it takes over the top of Home with cause, time, and what still works. The hourly-cap auto-downgrade renders as: "The AI hit your hourly limit, so it demoted itself to Ask-first."
6. **The system's own fail-safes are narrated, never silent.** Boot interlock ("app restarted → Autopilot off"), red-team-unavailable downgrades ("its reviewer was unavailable, so this came to you instead"), withheld unvalidated tuning, `placing_failed` reconciliation states ("we're confirming with the broker — this can't double-place"). Silent safety breeds mistrust; narrated safety builds it.
7. **No dark corners for the agent.** Chat cannot execute; drafts promote to the one rail; mobile commands can't touch mode or secrets; presets can't arm; learning can't touch numbers without a human card. The UI states these constraints where users would otherwise fear them.
8. **Honest absence.** `—` for missing data, `n/a` for computed-no-ratio, timestamps everywhere, "estimates, not advice" on tax, delayed-quote disclosure in the footer, and blocked/uncomputable analytics render as absent — never as invented numbers.
9. **Undo where possible, receipts where not.** Alerts, watchlist, guardrails (revert-to-safe), learning applies (ledger revert) are undoable; orders are not — so orders get the heaviest ceremony and the richest receipts.
10. **Self-notification as tamper alarm.** Live approvals, guardrail loosenings, arming events, and breaker trips echo to the user's phone by default — if you didn't do it, you find out in seconds.

---

## 7. What I would measure

**Safety comprehension (the core bet):**
- % of users who can answer "is this real money / is it armed / what can it spend today" correctly in a 3-question in-product quiz after week 1 (target >95%).
- Fire-drill completion and time-to-FREEZE in drills (target <10 s from any screen).
- Live-approval typed-challenge abandonment rate — some abandonment is *good* (deliberation working); track the reasons chip.
- Count of "surprise" support/chat queries like "why did it sell?!" that a receipt answers — should trend to near-zero.

**Trust calibration:**
- Approval rate over time in Test → Paper → Brokerage cohorts; healthy pattern is discriminating (not 100%, not 0%).
- Ideas-ledger engagement: do users who view "the ones you said no to" show approval-rate convergence toward positive-expectancy behavior?
- Graduation funnel: Test→Paper conversion, Paper→Brokerage conversion, median dwell per rung, % who *never* arm real money and stay happily in Test (a valid success state — measure retention there, not just conversion).

**Decision quality & load:**
- Median time from proposal → decision; % of proposals that expire undecided (high expiry = inbox overload → tune `maxProposalsPerRun` defaults).
- Receipt depth: % of decisions where the user opened layers 2+ before deciding.
- Post-decision regret proxy: reject-then-manually-buy-via-chat within 48h.

**Emergency & incident UX:**
- When breakers fire: time-to-user-acknowledgment; % who chose the intended next action (stay exit-only / resume / wind down) without support contact.
- Erroneous emergency use: FREEZE presses cancelled at the sheet (some is fine; a spike means the button placement is capturing mis-taps).

**System honesty checks:**
- Zero tolerated: any user-visible instance of unstamped mode, a fabricated value, or an approval succeeding across a mode mismatch (instrument and alert on these as product defects, not metrics).

---

## 8. Top 10 design principles

1. **Three questions, always answered:** *real? armed? spend?* — visible on every screen without a tap.
2. **Words before color.** Money-reality and agent state are words first; color, frames, and icons only reinforce.
3. **Friction mirrors risk, asymmetrically.** Stopping and tightening are one tap; starting, loosening, and spending require typing the meaning. The safe direction is always the cheap direction.
4. **The safe path is the default path.** Test mode, Ask-first, safe-by-default guardrails, do-nothing as a first-class outcome, expiry as the default decision.
5. **Rehearse the emergency.** Nobody meets the brake for the first time during a crash — mandatory fire drill, recurring practice, no typing to stop.
6. **One inbox for consent.** Everything the machine wants from a human — trades, memories, weight changes — arrives as the same card grammar in one place.
7. **Every decision gets a receipt.** Buy, sell, block, and skip all produce the same layered artifact: short version → evidence with provenance → debate → arithmetic of the rules → what happened since.
8. **Narrate the fail-safes.** Boot disarms, downgrades, reconciliations, and withheld learning are announced in plain words; silent safety reads as flakiness, narrated safety builds trust.
9. **Honest absence beats confident invention.** `—` vs `n/a`, timestamps everywhere, "delayed," "estimate," and analytics that vanish rather than fabricate.
10. **Chat drafts, rails execute.** Natural language is an on-ramp, never a bypass: one execution rail, one policy gate, one approval ceremony, no matter where an idea was born.
