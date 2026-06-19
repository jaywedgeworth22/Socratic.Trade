# Phase 10 - Stronger Signals, Learning & UI (v2 plan)

Forward plan consolidating every still-unimplemented idea, recommendation, and
consideration from this work stream — the Codex "Stronger Trading Signals And
Learning Loop" plan, the Codex optimization pass, the Codex review, and Claude's
brainstorms. Paper mode remains the default; **no live-trading behavior changes**.

## Status legend
`[done]` shipped · `[todo]` not started · `[partial]` partly done.

## Already shipped (context — do not redo)
Orphaned fundamentals + technical fields plumbed end-to-end (fcf/de/epsGr/senate/
insider/shortFloat/beta/pb/52w); 10-tag thesis playbook; `signal_snapshot` digest of
chosen proposals; thesis×regime scorecard + 20-lot gate + configurable shrinkage;
edge-aware Kelly-lite sizing (configurable bounds); deterministic rates-aware regime;
congress (Senate eFD + Capitol Trades), SEC Form 4, and **FINRA short-volume**
connectors; `candidates_considered` log; signal-efficacy + confidence-calibration
feedback; **event candidate union** (discovery); **source attribution** for web
signals; **/api/scan broker merge**; **shrinkPrior=0 = no shrinkage**; holding
horizon; tuning/tax settings; universal received-time tooltips; Smart Money panel;
SEC 8-K coarse bulletins; market breadth and internals; expanded FRED/macro
derived metrics; a Macro workspace tab; Fama-French, Cboe SKEW/VVIX, and CFTC
COT market-wide signals; Voyage/Pinecone RAG scaffolding for retrieved context.

Codex review findings P2(attribution), P3(/api/scan merge), P3(shrinkPrior=0), and
the discovery half of P2 are all **done**. What remains of P2 is the *ranking* half
(a smart-money sub-score) — Phase A below.

---

## Phase A — Make scraped signals affect deterministic ranking (highest leverage)
Closes Codex P2's remaining half ("recompute score/factorBreakdown after overlay,
add smart-money/catalyst sub-scores instead of leaving the LLM to infer from prose").

- **A1 `[done]` Positioning sub-score (new `ScoringWeights` factor).** Added a
  `positioning` factor (`positioningScore`) scored from congress net + insider
  sentiment + squeeze-level short interest; `scanMarket` now recomputes
  `factorBreakdown`/`score` AFTER the web overlay and re-sorts, so freshly-disclosed
  smart-money names rank up deterministically (not just in the prompt). Wired through
  `ScoringWeights`, `DEFAULT_SCORING_WEIGHTS` (0.8), `normalizeWeights`, the tuning
  LLM schema, and the UI weight editor (auto). `tsc` + 130 tests + build green.
- **A2 `[partial]` Expand the event union as new signal sources land.** The union
  pulls congress/insider/FINRA-short names and now **strong-bullish technical signals**
  (`hasNotableWebSignal` extended for `technical.direction==="bullish" && score>=70`; see
  the technical web source below). SEC 8-K currently contributes evidence bulletins/status
  but does not by itself union a below-cutoff name into the candidate set. Still to add:
  8-K event-union criteria if useful, earnings, options, and analyst-revision signals.
- **A2.1 `[done]` Technical-signal web source (TradingView push + in-house computed).**
  New `src/lib/indicators.ts` (pure RSI/MACD/SMA → `computeTechnicals`),
  `src/lib/web-sources/technical.ts` (one dataset, two producers, `TECHNICAL_SOURCE`
  env-selected), and `POST /api/webhooks/tradingview` (secret-gated receiver). The read
  overlays onto the scan, blends the `momentum` factor, joins the event union, emits a
  bulletin, and is captured in the evidence digest. `tsc` + 178 tests + build green; live
  webhook smoke-tested. Operator guide: `docs/tradingview-pine-setup.md`. Rollout:
  `docs/rollouts/2026-06-18-technical-signals-tradingview.md`. Deferred: a dedicated
  `technical` ScoringWeights factor (lighter `momentum`-blend chosen to avoid colliding
  with concurrent scoring edits); a real-time run trigger on high-conviction pushes.

## Phase B — Richer learning + full EvidenceDigest
Codex: "store full EvidenceDigest for chosen AND skipped … sector/factor-dimensional
learning … counterfactual return."

- **B1 `[done]` Sector on fills → sector learning dimension.** `recordFillFromProposal`
  stamps `sector` (from the scan quote) into the fill raw; `thesisMetaFromFill` carries
  it onto the lot + `ClosedLot.sector`; `getSectorScorecard` groups realized outcomes
  by sector and feeds the agent `sectorOutcomes`. `tsc` + 131 tests + build green.
  (thesis×regime×sector composite view still a follow-up.)
- **B2 `[done]` Full EvidenceDigest for chosen AND skipped candidates.** New
  `CandidateEvidence` type + `src/lib/evidence.ts` `buildCandidateEvidence()`; a single
  digest (factor sub-scores, `refPrice`, source freshness `asOf`/`provider`/`sources`,
  bulletins, sector, regime, congress/insider/short signals) now persists for the WHOLE
  scored set — `signal_snapshot.signals` = chosen + top-25 skipped (each tagged
  `chosen`), and `candidates_considered.topSkipped` upgraded from 4 fields to the full
  digest. `getSignalEfficacy` filters `chosen === false` (lot-driven join unaffected;
  old chosen-only snapshots without the flag still attribute). Unlocks B3
  (counterfactual forward return from `refPrice`) and B4 (factor-bucket learning).
  `tsc` + 139 tests + build green. See
  `docs/rollouts/2026-06-17-phase-10-b2-evidence-digest.md`.
- **B3 `[todo]` Counterfactual learning from skipped names.** Periodically mark the
  forward return of logged-but-skipped candidates and feed "names you passed that
  then ran" into the reflection. Needs lightweight price tracking. Risk: L.
- **B4 `[todo]` Factor-bucket learning.** Once A1 exists, bucket outcomes by dominant
  factor so the tuner can learn which factors pay. Depends on A1. Risk: M.

## Phase C — New free data sources (each a `web-sources` connector)
Codex: "major planned sources remain unimplemented." Default to free/official first.

- **C1 `[done]` SEC 8-K material-event bulletins.** New `web-sources/sec8k.ts`: the
  current-8-K atom feed + a weekly-cached CIK→ticker map → per-symbol "filed an 8-K"
  catalyst bulletins (rolling 4-day window), wired into the overlay/prompt + status.
  Fresh events now fetch the SEC filing summary page and capture item labels (for
  example Item 2.02 / Item 5.02) for richer bulletins and RAG context. Still not
  a full filing-text digest.
- **C2 `[done]` Market breadth.** `scanMarket` computes `breadthPct` (% of the full
  screener advancing today — free, from data already fetched) onto `MarketScan`; the
  agent gets `marketBreadth.advancingPct` with risk-on/off guidance. (% above
  50/200-DMA is a richer follow-up needing price history.)
- **C3 `[done]` Kenneth French factor returns.** `src/lib/market-signals/famafrench.ts`
  pulls free Data Library CSV ZIPs and feeds trailing factor returns into the
  `marketSignals` prompt block. Data lags, so treat it as a slow style-regime prior.
- **C4 `[partial]` Options / market-wide risk gauges.** `src/lib/market-signals/cboe.ts`
  pulls free Cboe SKEW and VVIX, and `cftc.ts` adds COT E-mini S&P positioning.
  True put/call ratios remain unimplemented; keep researching a stable free source.
- **C5 `[todo]` Analyst revisions / price-target changes / earnings calendar.** FMP
  endpoints are rate-limited on the current key → capability-gate behind a paid key,
  or find a free feed. M.
- **C6 `[todo]` SEC XBRL company-facts** for richer/standardized fundamentals. M.
- Each new source: persisted daily refresh, never-fabricate, evidence bulletins,
  source attribution, and a UI surface (Smart Money panel / scan column).

## Phase D — LLM efficiency & prompt quality
Codex: "make prompt compaction adaptive."

- **D1 `[partial]` Adaptive compaction.** Candidate payloads are minified and now
  drop neutral/empty values (undefined/null, non-finite numbers, empty bulletin/news
  arrays, zero `posMV`) before reaching the Bull/Bear prompts. Still open: globally
  send only fields changed since last run and make bulletin caps configurable per
  symbol/source.
- **D2 `[todo]` Prompt-cache the stable system prefix** (keep dynamic learning blocks
  last) to cut token cost.
- **D3 `[partial]` Async raw-document digests / retrieval.** Voyage + Pinecone RAG
  now stores/retrieves filing context for the Bull prompt path. The vector layer is
  tracked, initializes Pinecone once per key/index, supports batched `storeContexts`,
  embeds documents/queries with the right input type, and stores SEC 8-K item labels
  + filing links. Retrieved snippets are sent in the dynamic user payload as
  `retrievedFinancialContext`, not in the stable system prompt. Still open: full
  filing-text/news digests, stale-data flags, and timeout budgets for a
  production-grade document memory.
- **D4 `[todo]` Cross-source agreement flags** when providers disagree on a value.

## Phase E — UI
Codex: "symbol drilldown drawer … learning matrix."

- **E1 `[partial]` Symbol drilldown drawer.** Click a scan row opens a drawer with
  normalized 0-100 factor scores, provenance mappings, derived-metric tiles, and an
  AI conviction summary. Still missing: true weighted contribution/waterfall math,
  raw evidence links, and fuller freshness details.
- **E2 `[partial]` Learning-matrix UI.** The UI has learning-loop charts by
  thesis/regime, but not the full thesis×regime grid with raw vs shrunk stats,
  sample-size gates, signal-efficacy, confidence-calibration, and FINRA short-pressure
  surfaced to humans.
- **E3 `[partial]` Polish & customizability.** Macro tab and symbol price chart are
  live; still open: sparklines in the scan, saved column presets + density toggle,
  a holding-horizon chip near the strategy status, extend received-time tooltips to
  the Decision/Tax chips and portfolio rail, and a styleable touch-friendly tooltip
  component to replace native `title`.
- **E4 `[todo]` Expose scoring thresholds as settings** (FCF/D-E/EPS buckets, regime
  VIX cutoffs, red-team conviction trigger, edge-factor tiers) — currently code-level.
- **E5 `[todo]` De-risk-in-Crisis guardrail** (deterministic exposure cap when
  VIX>30 / inverted curve) — regime is context-only today.

## Phase F — Housekeeping (mostly non-code / user actions)
- **F1 `[todo]` Re-run the adversarial review** workflow on the UI batch (it hit the
  Anthropic session limit and never returned findings).
- **F2 `[user]` Fix git/Xcode license** — `xcode-select` points at full Xcode;
  commits go through the CLT workaround. Fix: `sudo xcode-select -s
  /Library/Developer/CommandLineTools`.
- **F3 `[done/superseded]` Merge `web-sources` → `main`.** `phase-10`, `main`, and
  `origin/main` are now aligned at `b86e461`; do not chase the old standalone
  `web-sources` merge item.

## Suggested sequencing
1. **D1 + D2** (efficiency) before sources balloon the prompt further.
2. **B3 + B4** (counterfactual skipped-name returns + factor-bucket learning).
3. **E1/E2 completion** (true contribution math, raw evidence links, learning matrix).
4. **C5 + C6** (analyst/earnings revisions and SEC XBRL facts).
5. **D3/D4 + E3–E5** (production-grade digests/RAG, cross-source disagreement,
   UI polish/settings/guardrails) as capacity allows.

## Cross-cutting acceptance (every phase)
`npx tsc --noEmit` clean · `npm test` green (with fixtures per new signal/source) ·
`npm run build` ok · no synthetic/"mock" data shown user-facing or to the LLM ·
missing provider keys → neutral/stale signals, never fake confidence · a
`docs/rollouts/*` note + `STATUS.md`/`PLAN.md` update per commit (AGENTS.md).
