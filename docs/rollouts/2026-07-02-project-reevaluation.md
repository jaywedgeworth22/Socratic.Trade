# 2026-07-02 — Full project re-evaluation (blind bottom-up UI redesign + findings sweep)

Branch: `claude/nav-v2-settings-ui-restructure` (docs-only commit riding on PR #315's branch for
accessibility; no code changed by this commit).

## Summary
Owner-requested full re-evaluation, run as one orchestrated workflow (`project-reeval-fable`,
run `wf_51bbbe31-81e`: **46 Fable agents, ~4.4M tokens** across two cap-interrupted resumes — the run is
journal-checkpointed, so nothing was lost). Two tracks:

1. **Blind bottom-up UI redesign** — a layout-agnostic capability inventory was built from `src/lib` + API
   surface only; three designers (novice-first "Steadyhand", operator-first "TradeDeck",
   explainability-first "Ledgerline") designed the entire interface from scratch, forbidden from reading any
   UI code or design docs; an informed adjudicator then compared them against the current UI and the
   approved nav-v2 plan. **Verdict: all four core nav-v2 bets independently re-derived (validated).** Six
   3/3-convergent gaps absent from the plan: Run Inspector + per-decision Receipt; STOP-copy honesty
   (halting pauses synthetic stops — the "always safe" tooltip is misleading; offer close-only);
   chrome freshness/heartbeat strip; narrated automatic transitions; per-position protection column;
   confidence-calibration scorecard. Ten concrete amendments to PRs #9–#14 recommended.
2. **Findings sweep** — 10 dimension reviewers produced **140 findings**; every P0/P1 was adversarially
   verified (29/29 CONFIRMED, 0 refuted). Corrected tally: **2 P0 · 19 P1 · 72 P2 · 47 P3** + 11
   completeness-critic additions. The two P0s: (1) breaker/vol-brake/cap halts persist to the ACTIVE
   account, not the account that breached (`strategy.ts`); (2) newly-activated accounts seed
   systemState/authority from the library profile (`db-profiles.ts`; partially mitigated by in-flight
   PR #310 — the authority inheritance remains).

## Files (added, docs only)
- `docs/reviews/2026-07-02-project-reevaluation/project-reevaluation-report.md` (the full report)
- `.../design-adjudication.md`, `.../blind-design-{novice,operator,explainability}-first.md`
- `.../capability-inventory.md`, `.../current-ui-map.md`
- This rollout note.

## Verification
Docs-only; verify trio not required. Findings evidence was verified inside the workflow by per-finding
adversarial refuters against the working tree (main post-#305/#307/#312 + the 8-node settings commit).

## Follow-ups
- Fix the 2 confirmed P0s + the STOP-copy correction (also flagged by all three blind designs).
- Fix the NAV_V2 settings-tree `userNode`/`section` desync found by the sweep (on PR #315).
- Fold the 10 adjudication amendments into `docs/settings-navigation-redesign/spec/` for PRs #9–#14.
- Triage the 19 confirmed P1s into a fix queue (report §2.1).
