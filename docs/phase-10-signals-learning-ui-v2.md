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
horizon; tuning/tax settings; universal received-time tooltips; Smart Money panel.

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
  already pulls congress/insider/FINRA-short names; extend `hasNotableWebSignal` to
  8-K / earnings / options / analyst-revision signals as Phase C delivers them.

## Phase B — Richer learning + full EvidenceDigest
Codex: "store full EvidenceDigest for chosen AND skipped … sector/factor-dimensional
learning … counterfactual return."

- **B1 `[done]` Sector on fills → sector learning dimension.** `recordFillFromProposal`
  stamps `sector` (from the scan quote) into the fill raw; `thesisMetaFromFill` carries
  it onto the lot + `ClosedLot.sector`; `getSectorScorecard` groups realized outcomes
  by sector and feeds the agent `sectorOutcomes`. `tsc` + 131 tests + build green.
  (thesis×regime×sector composite view still a follow-up.)
- **B2 `[todo]` Full EvidenceDigest for chosen AND skipped candidates.** Persist per
  candidate (not just chosen): factor sub-scores, source freshness, bulletins,
  sector, regime — extend `signal_snapshot` to cover the scored set and enrich the
  `candidates_considered` log beyond its current minimal fields. Risk: M.
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
  Live-verified (94 events). Coarse (no per-item 8-K detail yet — follow-up).
- **C2 `[todo]` Market breadth** (advancers/decliners, % above 50/200-DMA) as a
  regime input. Free. Small/M.
- **C3 `[todo]` Kenneth French factor returns** (free CSV) as factor priors. M.
- **C4 `[todo/blocked]` Options / put-call ratios.** Cboe's CSV is 403 and the page
  is HTML-only; research a working free source before building. L.
- **C5 `[todo]` Analyst revisions / price-target changes / earnings calendar.** FMP
  endpoints are rate-limited on the current key → capability-gate behind a paid key,
  or find a free feed. M.
- **C6 `[todo]` SEC XBRL company-facts** for richer/standardized fundamentals. M.
- Each new source: persisted daily refresh, never-fabricate, evidence bulletins,
  source attribution, and a UI surface (Smart Money panel / scan column).

## Phase D — LLM efficiency & prompt quality
Codex: "make prompt compaction adaptive."

- **D1 `[todo]` Adaptive compaction.** Per candidate, send only non-neutral signals;
  globally send only fields changed since last run; hard-cap bulletins per symbol.
- **D2 `[todo]` Prompt-cache the stable system prefix** (keep dynamic learning blocks
  last) to cut token cost.
- **D3 `[todo]` Async raw-document digests** (filings/transcripts/options) into
  bulletins with **source links, timestamps, and stale-data flags** — raw never in
  the prompt.
- **D4 `[todo]` Cross-source agreement flags** when providers disagree on a value.

## Phase E — UI
Codex: "symbol drilldown drawer … learning matrix."

- **E1 `[todo]` Symbol drilldown drawer.** Click a scan row → **score waterfall**
  (factor contributions), source provenance + freshness, raw evidence links, and a
  "why this matters" summary.
- **E2 `[todo]` Learning-matrix UI.** Thesis×regime grid with raw vs shrunk stats and
  sample-size gates; surface signal-efficacy, confidence-calibration, and FINRA
  short-pressure to the human (all agent-only today).
- **E3 `[todo]` Polish & customizability.** Sparklines in the scan; saved column
  presets + density toggle; a holding-horizon chip near the strategy status; extend
  received-time tooltips to the Decision/Tax chips and portfolio rail; a styleable,
  touch-friendly tooltip component to replace native `title`.
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
- **F3 `[user]` Merge `web-sources` → `main`** (clean fast-forward; left to you).

## Suggested sequencing
1. **A1 + A2** (ranking) — biggest leverage, makes existing scraped data matter.
2. **B1 (sector) + B2 (EvidenceDigest)** — unlock the deferred learning dimensions.
3. **C1 (8-K) + C2 (breadth)** — cheap, high-signal free sources that feed A2/D.
4. **D1 + D2** (efficiency) before sources balloon the prompt.
5. **E1 + E2** (drilldown + learning matrix) once the underlying data exists.
6. **C3–C6, B3/B4, D3/D4, E3–E5** as capacity allows.

## Cross-cutting acceptance (every phase)
`npx tsc --noEmit` clean · `npm test` green (with fixtures per new signal/source) ·
`npm run build` ok · no synthetic/"mock" data shown user-facing or to the LLM ·
missing provider keys → neutral/stale signals, never fake confidence · a
`docs/rollouts/*` note + `STATUS.md`/`PLAN.md` update per commit (AGENTS.md).
