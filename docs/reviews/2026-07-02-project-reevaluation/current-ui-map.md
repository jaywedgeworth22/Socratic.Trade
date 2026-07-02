# Current UI Map — agentic-trading (working tree, 2026-07-01 evening)

**Tree state:** `main` after GitHub PRs #303 (nav-v2 ladder PR #1), #305 (ladder PRs #2–#6, flag-gated), #307 (web-signal bulletin merge fix), #312 (CI merge_group), plus one un-pushed commit `e9f4392` — "#3-physical", the NAV_V2-gated 8-node Scope-B settings tree in `app/dashboard-client.tsx`. GitHub PR #310 (ladder PRs #7+#8: view/execution decouple + wash-sale provenance, touching `src/lib/db-profiles.ts` and `src/lib/tax.ts`) is in-flight and **NOT** in this tree — every singleton/coercion hazard described below is still live code here.

**Flags:** `NAV_V2` (env `NEXT_PUBLIC_NAV_V2` + localStorage override `nav-v2`, default **off**) and `STRATEGY_CONSOLIDATION` (env `NEXT_PUBLIC_STRATEGY_CONSOLIDATION` + `strategy-consolidation`, default **off**). With both off — the production default — rendering is byte-identical to the pre-redesign UI except for PR #1's copy relabels and the `/strategy → /how-it-works` route rename. A flag-independent localStorage shim (`migrateNavKeysToDestinations`, `app/nav-destinations.ts`) already seeds new `dashboard-destination` / `dashboard-feed-destination` keys on every mount, but the legacy `dashboard-workspace-tab` / `dashboard-feed-tab` keys still drive rendering.

---

## A. The as-shipped UI today

### Routes

| Route | What it is |
|---|---|
| `/` (`app/page.tsx` → `app/dashboard-client.tsx`, 7,238 lines) | The entire app: SSR shell → blocking data-pool ConsentGate → `DashboardApp`. Everything below lives in this one client file. |
| `/welcome` | Public marketing/onboarding page: 6 feature cards, 3 "how it works" steps, mailto access-request CTA (`mail@jays.services`), links to `/how-it-works`. |
| `/how-it-works` | Public strategy explainer (formerly `/strategy`), gated by `LANDING_PAGE_ENABLED`. `/strategy` is now a **gated redirect shim** — both paths 404 when the landing flag is off (ladder PR #5, gap #2). |
| `/login` | Minimal OAuth page (Google/GitHub/Apple, whichever env-configured; `force-dynamic`). Outside the app chrome. |
| `/access-denied`, `/logout` | Allowlist rejection page; sign-out. |
| `/mobile` | Standalone PWA companion (see below). |
| `/admin/connections` ("API Connections Health"), `/admin/llm-usage` ("LLM Usage & Cost"), `/admin/rag-coverage`, `/admin/transcript` ("Chat Transcript") | Four standalone role-gated operator pages under a bare `app/admin/layout.tsx` (just a themed div — the role gate is middleware/page-level). **Not yet consolidated** into Settings → Admin; the NAV_V2 Admin node is only a pointer card linking to `/admin`. |

### Persistent chrome (sticky header, `DashboardApp`)

1. **Execution-mode safety banner** (top strip): Test / Paper / Brokerage wording + color; user-selectable Full / Compact / Hidden modes persisted in localStorage (legacy-key migration keeps upgrading users from silently losing it).
2. **Command bar** —
   - **Left:** app logo + "Trading Dashboard"; two status lines: run-state dot ("Running · Propose Mode" / "Running · Autonomous Mode" / "Stopped" / "Close-Only" / "Liquidating" / "Setup Needed") and market-session status. Next to it, a **Universe pill** (index label or "Custom"/"TBD") and a **Daily Risk pill** (used vs `maxDailyNotional`, %).
   - **Right:** **Mode select** (Propose Mode / Autonomous Mode; switching to Autonomous opens a danger ConfirmModal); the **active-account `<select>` switcher** (flat option list, appends "(paper)"-style environment only when two labels collide, plus a "Manage Accounts..." entry) — note this is the **execution singleton switch**, `activateAccount()` → `POST /api/connected-accounts/:id/activate`; the **AccountMenu avatar** (Settings, Accounts, Activity, Help, Sign out); a **LearnedContextQueueBadge** (pending learned-context count, opens a review SlideOver); **"Run once"** (primary; disabled/ghost with actionable tooltip when account/universe/LLM-credential gates fail); and the **Start/STOP** button (relabeled from "Halt & Flatten" by ladder PR #1; tooltip "Halts new activity in one click. Always safe — never sells anything you hold."; handler unchanged — it toggles `systemState` active/halted via a ConfirmModal; **no separate Flatten action exists**).
3. **⌘K command palette** (`app/ui/command-palette.tsx`): ~14 commands — jump to each of the 6 tabs, open Activity feed, Settings (→ "operate"), Accounts, Strategy Flow, Strategy Studio, Help, "Run strategy once" (inherits the same setup gating as the chrome button), Sign out.

### Body layout

- **Left rail** (desktop only): `PortfolioRail` — "Portfolio" panel (equity, cash, buying power, positions with drill-down ticker buttons, watchlist). On mobile widths a condensed `MobilePortfolioSummary` renders above the main column.
- **ReadinessStrip**: Account / Universe / Risk Caps (+ conditional Robinhood MCP) checklist chips, each with a jump action (Accounts modal or Settings → Operate).
- **7 workspace tabs** (`WorkspaceTab` union; persisted): **Decision · Assistant · Market Scan · Macro · Performance · Tax · Strategy**, with a "N pending approvals" chip beside the Decision tab.

### What lives in each tab

- **Decision** (`DecisionView`): the HITL surface. "Pending Approval" panel — proposal cards with symbol/side, estimated notional & share count, side-adjusted price drift since proposal, rationale, Approve / Reject buttons (approving on a live brokerage account opens the typed-confirmation `ConfirmationModal`; approving while stopped warns). Below it "Latest Decisions": the most recent run's per-symbol decisions, debate output, and skip reasons.
- **Assistant** (`app/ui/assistant-console.tsx`): a chat **workspace tab** (not an overlay) with model picker, seven router-matched suggestion chips (Ask / Knowledge / Portfolio / Watchlist / Alert / Track / Draft), and order-drafting that routes to the approval queue. Disabled with a pointer when no LLM credential resolves.
- **Market Scan** (`MarketScanView` + `SmartMoneyView`): configurable-column ranked quote table (price, intraday chg, vs VWAP, volume, mkt cap, P/E with the "n/a"-vs-"—" convention, factor scores, per-cell source/freshness tooltips), column picker persisted, manual refresh, links to Settings → Operate (universe) and Settings → Data (scan breadth). SmartMoney below: **Congressional Trades** and insider/short-signal panels with source + freshness lines.
- **Macro** (`app/ui/macro-panel.tsx`): regime tiles, ~90-day sparkline indicators, top movers strip, market-breadth cards; tickers open the symbol drill-down.
- **Performance** (`PerformanceView`): "Equity" panel (mode-labeled), "What's Working — By Thesis" (realized P&L by trade thesis — the learning loop), "By Market Regime".
- **Tax** (`TaxView`): "Tax" summary panel, "Wash-Sale Lockout" list (blocked rebuys, 30-day), "Tax-Loss Harvest Candidates", "Holding Period — Days To Long-Term" ladder.
- **Strategy** (`StrategyView`): "Active Strategy" panel — mode subtitle, saved strategy-profile chips ("Preset" in new copy), **"Copy this strategy to another account"** picker (`applyProfileToAccount` path), save-current-as-profile input, **Edit** button → Strategy Studio modal, **Flow** button → Strategy Flow modal; "Key Parameters" inline-edit grid (max proposals/run, cadence, max daily orders, max hourly notional, portfolio beta, avg correlation, entry drift %, quote/fundamentals age, sell-to-fund-buy toggle, sector caps); "LLM Strategy Review" — the **TuningCard** (generate an advisory review, apply/discard a policy+prompt patch).

### Feed rail (SlideOver, not a tab)

"Activity" SlideOver (opened from AccountMenu or palette) with **4 feed tabs**: **Activity** (trading log incl. replace-stale-market-order action), **Runs** (run history), **Alert history** (id still `notifications`; relabeled by PR #1), **Audit Log**.

### Modals & overlays (all inside dashboard-client)

| Surface | Contents |
|---|---|
| **Settings** (xl modal) | See below. Header actions: "Connection Status" (admins → `/admin/connections`) and "Manage Accounts". |
| **Accounts** (lg modal, `IntegrationsSection`) | Broker connections: Test sim account, Alpaca / Alpaca MCP (Paper vs Brokerage, custom endpoint option), Robinhood (OAuth + MCP health check/sync), hide-test-account toggle. |
| **Strategy Studio** (xl modal) | Prompt editor, Green Team model, Red Team model, Reasoning Effort, 8-slider `ScoringWeights`, and a **second TuningCard render site** — under `STRATEGY_CONSOLIDATION` this duplicate is replaced by a one-line pointer to the Strategy tab (ladder PR #6). |
| **Strategy Flow** (full-screen modal) | Read-only live pipeline diagram (`app/ui/strategy-flow.tsx`). |
| **Help** (xl modal) | 6 tabs: Overview, Guardrails, **Settings Glossary** (under NAV_V2 shows the old→new relocation table + rule-of-thumb from `SETTINGS_GLOSSARY`, ladder PR #4), Tax, Data Sources, MCP Connection. |
| **Symbol drill-down** (SlideOver) | Full quote intelligence for any clicked ticker (price chart, fundamentals, signals). |
| **Learned-context queue** (SlideOver) | Approve/reject pending learned-context items. |
| **Confirms** | Start/Stop ConfirmModal; Autonomous-mode danger confirm; live-order typed `ConfirmationModal`; `MarketReplaceModal` (typed on live); `AccountDeletionModal` (typed identity + phrase). |
| **ConsentGate** | Blocking shared-data-pool consent on first load. |

### Settings modal structure (the load-bearing part)

Header card: scope icon + title ("User Settings" / "Account Settings"), a **scope Chip** ("THIS ACCOUNT" accent / "ALL ACCOUNTS" neutral — ladder PR #1, driven by `app/settings-scope.ts` `settingsTierForSection`), and a **User | Account segmented control**.

- **Account tier** (5 tabs; an account-picker row sits above them): **Strategy** (read-only pointer card + Green/Red/Reasoning KeyVals → "Open Strategy Studio"), **Operate** (execution-mode banner, Base Indexes multi-select, Additional Watchlist, Ignore List, Approval Mode, Holding Horizon), **Safety** (`risk`: drawdown & daily-loss breakers, VIX/VVIX/SKEW vol-panic thresholds, gross/net exposure caps, trailing stop, take-profit trim %, ATR stop period/multiple, short stop/order/exposure limits, max order % of ADV, stale-limit alert, universe floor min price/mkt-cap/$-volume, banner & ticker-logo display prefs), **Tax** (account tax treatment incl. IRA sheltering, wash-sale guard, ST/LT rates), **Tuning** (shrinkage prior, min lots, sizing floor/ceiling, red-team threshold, crisis open cap, min proposal score, FCF-yield veto, debt/equity veto, negative-EV skip).
- **User tier, flag OFF** (production, 4 tabs): **Connections** (`ApiKeysSection`: LLM + market-data provider keys), **Appearance** (`display`), **Alert delivery** (`notifications`: webhook URL, per-event routing, `DeliveryChannelsPanel` with test-send), **Data & Privacy** (`data`: market-scan Candidate cap + Outlier reserve, pool consent, learned-context sharing toggles, account-deletion panel). A "Resume strategy on server restart" toggle renders in the user tier regardless of flag.
- **User tier, NAV_V2 ON — the new 8-node tree** (commit `e9f4392`, `UserNode`/`USER_NODE_TABS`): **Account & Security** (identity line + the *relocated* `AccountDeletionPanel`), **Connections** (pointer card → Accounts modal; notes keys live under Keys & Models), **Keys & Models** (maps to the legacy `connections` API-keys section), **Alert delivery** (→ `notifications`), **Data & Privacy** (→ `data`, deletion panel removed under flag), **Presets** (pointer copy only — CRUD not lifted yet), **Appearance** (→ `display`), **Admin** (admin-gated pointer card → `/admin`). Four nodes reuse existing sections via mapping; four are new panels/pointers. Every legacy block is guarded `section === X && (!navV2 || userNode === "…")` so exactly one node renders and flag-off is byte-identical. Above the tabs, a **Scope-A signpost card** ("Looking for strategy or risk settings? … if a setting changes how a trade is decided or placed, it belongs to the account") with "Open Strategy ›" / "Open Guardrails ›" jumps that flip the tier to account (`strategy` / `risk` sections) — ladder PR #3's governing-rule divider.

Supporting pure modules (all landed, mostly not yet driving live renders): `app/nav-destinations.ts` (DestinationTab/FeedDestination unions + mapping + shim + flags), `app/settings-scope.ts` (tier SSOT + scope tags), `app/settings-search.ts` (`SETTINGS_FIELDS` catalog → derived `GUARDRAILS_ESSENTIALS` (5 fields, "Max order size (per trade)" bound to `maxOrderNotional`), `searchSettings`, `LEGACY_SECTION_RELOCATION`, `SETTINGS_GLOSSARY`).

### `/mobile` PWA page

Single-column client (`app/mobile/mobile-pwa-client.tsx`, 638 lines): snapshot header with refresh, run-state/readiness summary, a **Stop** button, **Approvals** (approve/reject with per-proposal live typed-confirm text), **Watchlist** (add/remove), **Price Alerts** (symbol/op/price CRUD), **Positions**, **Command Log** (the page is command-queue driven: `POST /api/mobile/commands` with idempotency keys; statuses queued/running/succeeded/failed/cancelled), and a **Delete app account** flow. It has **no account switcher**; `src/lib/mobile-api.ts:649` still writes the execution singleton (`setActiveConnectedAccount`) — a named hazard PR #7 re-points.

---

## B. The approved nav-v2 target and what remains (faithful summary)

**Source:** `docs/settings-navigation-redesign.md` (canonical, owner-approved 2026-07-01, all 7 open questions resolved) + the buildable spec in `docs/settings-navigation-redesign/spec/` (start `00-README.md`; delivery ladder in `08-delivery-plan-prs-and-tests.md`; clickable prototype in `prototype/index.html`).

**The diagnosis it fixes:** the app exposes ~40+ navigation surfaces — 7 workspace tabs + 4 feed tabs + a 9-section two-implicit-tier settings modal + 7 major modals + profile menu + palette + 9 routes. Strategy config lives in five places; "Tax" and "Notifications" each label both a view and a config surface; and the account/user scope split exists in code but is invisible, atop three un-named scope concepts (Connected Account, Strategy Profile, user-global).

**Twelve design principles**, the load-bearing ones: (P1) the **Account is the primary object** — a persistent frame you select, never a destination; (P2) **view-scope and execution-scope must be decoupled in code first** — today the active account is a persisted singleton and non-active accounts are coerced `→ halted` on the next policy write, so switching is *not* free until that migration ships; (P3) scope is an authority grant, validated server-side on every mutating write; (P4) money-reality (Test/Paper/Live) and authority (Propose/Decide) are two orthogonal dials; (P5) practice-vs-real is stated in words ("PAPER · practice money"), never color alone; (P6) Strategy (brain) and Guardrails (fence) are separate destinations on one config engine — the autonomy dial lives in Guardrails; (P7) the AI and preset edits get no side door — the ambient `mirrorPolicyToActiveAccount` is deleted from all three call sites; (P8) presets **copy, never live-link**, with three-way-diff resync honoring per-field Live friction; (P9) safe defaults + type-to-confirm reserved for the two one-way doors (arm Live, arm Auto-on-Live) + first-Live-act re-consent; (P10) novice floor / power ceiling — Essentials with one Advanced reveal; (P11) **single-account users see zero multi-account chrome** (the rollout wedge); (P12) everything ships incrementally behind flags with rollback.

**Target IA:** six verb destinations — **Dashboard** (account status, positions, guardrail gauges, approval top-N; becomes **Fleet** in All-accounts), **Approvals** (HITL queue: debate, policy-gate checklist, drift meter, MODE badge *on the Approve button*, adjust-and-approve re-runs the full gate; in Decide mode it's the auto-executed ledger), **Scan** (deliberately secondary, read-only), **Strategy** (the *one* editable home: Thesis / Signals / AI Review + a Presets bar), **Guardrails** (opens on 5 Essentials — max order size, daily-loss stop, stop-loss toggle, autonomy dial, extended-hours — everything else behind one Advanced reveal), **Results** (renamed from Review: P&L vs SPY, scorecards, tax outcomes, Tuning queue, Alert history, canonical audit home). The **Assistant is a persistent slide-over**, not a tab. **Settings is off the primary rail** (avatar/switcher footer), user-global only, with exactly the 8-node tree: Account & Security, Connections, Keys & Models, Alert delivery, Data & Privacy, Presets, Appearance, Admin (consolidating all four `/admin/*` targets as redirect shims). The "Notifications" noun is retired for the **Alerts** family (🔔 Alerts stream / Settings → Alert delivery / Results → Alert history).

**Global chrome:** a three-zone frame — LEFT the **account switcher chip** (alias · broker, word-class money badge, authority chip, equity + day P&L; dropdown groups Live first, a distinct **Sandbox** section for Test, "All accounts (Fleet)" on top; static chip for single-account users); CENTER the destination spine; RIGHT ambient risk strip + **"Run once — <account> · <MODE>"** (target stamped on the button) + **■ STOP** (one click, never sells — **Flatten is a separate confirmed action**) + 🔔 + ⌘K + ? + avatar. A Live account paints a red viewport hairline.

**Multi-account model:** three named entities — Connected Account (the scope unit), **Preset** (renamed from Strategy Profile; inert template, copy-on-bind with `derived_from_profile_id` provenance and "diverged: N fields" diffs), User-global (**exactly three fields**: `notificationSettings`, `marketScanCandidateLimit`, `marketScanOutlierReserve`). Resolution is USER-GLOBAL → PRESET → ACCOUNT OVERRIDE → EFFECTIVE with origin badges (behind Advanced for novices). Wash-sale is a **third, cross-account tax-coupling class**: enforcement already exists (`policy.ts:321`), but the lockout function must gain per-symbol provenance and Test-account exclusion before Approvals can name the culprit ("locked by a loss in Robinhood · LIVE, clears Jul 24").

**Delivery ladder (spec/08) and status in this tree:**
- **#1 relabels + scope tags — LANDED** (GH #303).
- **#2 DestinationTab mapping + localStorage shim — LANDED** (GH #305); mapping exists, panels unmoved.
- **#3 settings scope-first tree — logic layer LANDED** (catalog/search/Essentials/signpost, GH #305); **physical 8-node tree LANDED in working-tree commit `e9f4392`**. Still deferred: live Guardrails Essentials→Advanced reveal, Presets CRUD lift, Keys & Models default-model controls, settings-search UI.
- **#4 openSettings rewrites + /admin consolidation — glossary/relocation map LANDED**; the live rewrites of the 6 `openSettings("operate")` sites and the `/admin/*` redirect shims are **pending** (staged to the shell).
- **#5 Strategy consolidation — `/strategy → /how-it-works` LANDED**; Studio-modal→inline move and Strategy-Flow read-only reclassification **pending**.
- **#6 TuningCard merge — LANDED** behind `STRATEGY_CONSOLIDATION` (default off).
- **#7 ⛔ THE GATE (view/exec decouple, coercion removal, server-side write-time accountId validation, plural arming + autonomy-reset-on-restart, mobile-setter re-point) and #8 (wash-sale provenance + Test filter) — in-flight as GH PR #310, NOT in this tree.** No switcher chrome (PR #9+) may merge before #7 is on main; CI grep-gates enforce it.
- **#9 three-zone shell + STOP/Flatten split, #10 account switcher + single-account-first, #11 Approvals destination + wash-sale culprit naming — not started.**
- **#12 Fleet, #13 `/a/:accountId` route encoding, #14 mobile account-scope parity — deferred.**

---

## C. Known, documented pain points

From the redesign doc's forensic map (Appendix A), the red-team (Appendix J), spec/05, `docs/settings-and-universe-overhaul-plan.md`, and rollout notes:

1. **The execution singleton (the #1 safety issue, still live here).** `getActiveConnectedAccount` is persisted; `db-profiles.ts:284/350/397` coerce any non-active account `systemState → "halted"` on its next policy write, so the header account `<select>` has real execution consequences — mid-task switching can silently halt the account you left running. `mirrorPolicyToActiveAccount` (`:486/:512/:531`) lets a preset edit ambiently rewrite whatever account is active. `mobile-api.ts:649` writes the same singleton. All addressed by in-flight PR #310, not in this tree.
2. **Wash-sale provenance + Test leak.** `getUserWashSaleLockedSymbols` returns a flat `Set<string>` (no contributing account / clear date), and `tax.ts:113` maps `broker === "test"` to `source: "paper"`, so a *simulated* loss can lock a rebuy on a *real* taxable account. Enforcement itself is authoritative and must not be weakened. (PR #310.)
3. **Strategy config fragmented across 5 surfaces** (Strategy tab, Strategy Studio modal, Settings → Strategy, Strategy Flow overlay, public explainer) with the duplicated TuningCard at two render sites (`:3725`/`:4441`) — dedup exists but is dark behind `STRATEGY_CONSOLIDATION`.
4. **Scope invisibility / vocabulary collisions.** Account-vs-user tier was coded but unlabeled (PR #1's chips are the first surfacing); "Tax" still means both a tab and a settings section; three scope concepts (account / profile / user-global) remain visually undistinguished; no origin badges or effective-value provenance anywhere yet.
5. **Kill-switch semantics.** STOP is relabeled but the handler is still the run-state toggle behind a confirm — it is *not* one-click, and there is no separate Flatten. "Run once" is not stamped with its target account/mode; money-reality is conveyed by banner color + words at the top, not bound to commit actions (no MODE badge on Approve).
6. **Settings honesty & overload.** The overhaul program (`settings-and-universe-overhaul-plan.md`) surfaced the ~17 enforced-but-invisible policy fields (Phases 1–3 done), but the result is a wall of ~120–150 knobs with no Essentials/Advanced layering live; the Essentials catalog exists only as data. The 6 `openSettings("operate")` call sites still open the modal that the redesign will gut.
7. **Monolith risk.** `dashboard-client.tsx` is 7,238 lines holding every view, modal, and the ~1,000-line settings body; spec/07 defines the decomposition, and every physical restructure PR names the teardown of this file as its main hazard (why #4/#5-physical were staged to the shell).
8. **Navigation sprawl + persistence debt.** ~40 surfaces; 7 tabs + 4 feed tabs vs the 6-destination target; legacy localStorage tab keys still authoritative (new destination keys seeded but unread); `approvals`/`guardrails` destinations currently alias to `decision`/`strategy` panels.
9. **Mobile gap.** `/mobile` has no account context or switcher and drives the singleton; parity is deferred to ladder PR #14.
10. **Zero-account first-run.** No guided "connect your first account" flow; six destinations' worth of chrome renders regardless (target: Test pseudo-account auto-provisioned, destinations greyed).

**Verification state at `e9f4392`** (per rollout note): `tsc` clean · lint 0 errors · `npm test` 205 files / 2069 tests green · `build` success; flag-off byte-identical. The 8-node tree itself is flagged "requires preview-QA (flip `NAV_V2`)" — it has not been browser-tested.
