# 2026-07-08 — Model-picker labels + Red-team recommendation fix (MONET)

## Summary
Owner review of the Green/Red model pickers found (1) role-flavored, grammatically
inconsistent descriptors and (2) an incoherent Red-team recommendation. Fixed in both
catalog copies (`app/console/settings/models.tsx` + `app/ui/llm-model-catalog.ts`).

## Why / decisions
- **Labels must be role-neutral**: one catalog feeds BOTH pickers, so "premium Claude
  *critique*" (opus) and "fast Claude *review*" (haiku) baked the Red role into
  model descriptors shown in the Green picker too. Now: haiku = "fast low-cost
  Claude", opus = "premium Claude reasoning" (parallel to "deepest OpenAI
  reasoning"; forms the Anthropic ladder analysis → reasoning → most capable).
- **Red recommendations follow one principle**, now documented in a comment above
  each catalog: per provider, `recommendedGreen` = the stable fast/balanced $$
  workhorse (runs every tick); `recommendedRed` = the strongest **stable** reasoner
  at sustainable per-proposal cost. That resolved the owner-flagged inconsistency
  (Sonnet $$ vs Gemini 3.1 Pro $$$ both "recommended"): the real defect was
  recommending a ***-preview* build for the money-path adversary seat. Moved the
  Gemini Red recommendation from `gemini-3.1-pro-preview` to the stable
  `gemini-3.5-flash` (matching DeepSeek's both-roles shape); Sonnet keeps its Red
  rec (strong stable reasoning at $$, cross-family diversity from common Green
  picks). Preview models remain selectable, just unrecommended.

## Files
- `app/console/settings/models.tsx` — labels, rec flags, convention comment.
- `app/ui/llm-model-catalog.ts` — same (kept in sync per the header note).
- Flags are display-only (`model-picker.tsx` type + label suffix in
  `console/strategy/page.tsx`) — no behavior change.

## Verification
- `npx tsc --noEmit`, `npm run lint`, `npx vitest run`, `npm run build` — run via
  `land.sh` gate (results in PR).

## Follow-ups
- The in-flight `monet/single-adversary-consolidation` branch also edits
  `models.tsx` — flagged on #agent-sync to rebase over this.
