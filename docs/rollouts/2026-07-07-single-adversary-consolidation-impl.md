# 2026-07-07 — Single-adversary consolidation: drift found + owner-revised, implementation started

## Summary
- **Discovery:** `docs/single-adversary-consolidation.md` (all §9 decisions RESOLVED
  2026-07-01, Codex-reviewed) was **never implemented**. Verified: both adversarial
  passes still run — the in-flow Bear inside `proposeTrades` (`src/lib/strategy.ts`
  ~`4406`, `step:"bear"`) AND the escalated `debateProposal` (`src/lib/red-team.ts:81`,
  called `src/lib/strategy.ts:1282`, gated by `shouldRunRedTeamDebate` `:2206`). Code
  cross-check: `grep -rn "approve-at-half\|adversaryUnavailable\|extractJsonPayload\|fetchLlmWithRetry" src` → nothing.
- **New binding rule** added to `AGENTS.md` ("Design-vs-implementation drift — FLAG
  IT") + announced in `#agent-sync`: every agent must verify design docs against code,
  flag decided-but-unimplemented work to the owner, stamp the doc, keep an EFFORT-LOG row.
- **Owner revision (2026-07-07)** of the spec's independence model (banner added to the
  spec top). New rules govern and override §3.8/§8/O4/R12–R14:
  - No model default for anything, ever (delete Green default, red→green fallback,
    cross-family default map, env default).
  - Green + Red models both mandatory + explicitly chosen; impossible to run without
    both (enforce at policy-save + Settings UI; fail-closed at runtime as backstop).
  - Only providers the user holds a key for are selectable in Settings.
  - Same model for both allowed if chosen; drop hard same-model prohibition + write-time
    independence enforcement; independence is a non-blocking Settings hint, never a gate.
  - Unchanged: one adversarial call doing both jobs, kill `RED_TEAM_LLM_PROVIDER` env
    override, exits never reviewed, all-openings coverage, never-silent failure, §4
    reliability + §5–§7 visibility/persistence (R1–R20).

## Audit — other specced-but-unimplemented / deferred work found (2026-07-07)
- **Confirmed silent miss:** single-adversary consolidation (this effort).
- **Historical miss (since fixed):** PR #161 multi-provider chat "never landed" —
  `docs/rollouts/2026-06-25-chat-multi-provider-models.md:11`.
- **Honestly-labeled DEFERRED (tracked, not silently dropped)** in
  `docs/phase-7-strategy.md`: House congressional coverage (needs free feed),
  Šidák/Bonferroni multiple-testing correction, P1-5 calibration; and
  `docs/rollouts/2026-06-20-money-path-merge-gate.md:39` "Follow-ups (user-approved,
  not yet implemented)". These are acknowledged, not thought-shipped.
- A full forensic pass over the 1471-line EFFORT-LOG + git history was not done; the
  above is the clearly-identifiable set from status markers + code cross-checks.

## Implementation plan (staged, current-code-grounded — spec anchors have drifted; UI moved to app/console)
1. **Model rules (foundation):** `src/lib/llm-provider.ts` (`resolveRoleModel`,
   remove Green/red defaults) + `src/lib/llm-request.ts` (`resolveOpenAiModel`) →
   no defaults; typed "unconfigured" result. `app/api/policy/route.ts` validation +
   `app/console/settings/models.tsx` → both required, keyed-providers-only dropdown,
   same-model allowed.
2. **One adversary:** delete in-flow Bear LLM in `proposeTrades` (keep
   `deterministicBearFilter`); rewrite `debateProposal` (`src/lib/red-team.ts`) as the
   single reviewer told to do both jobs (fact-check candidate evidence + finalized-size
   critique); remove the second call site's duplication; kill `redTeamProvider()` /
   `RED_TEAM_LLM_PROVIDER`.
3. **Reliability (R9/R10/R1–R4):** `extractJsonPayload` in `src/lib/llm-call.ts`
   applied at all parse sites; `fetchLlmWithRetry`; three-verdict + `approve-at-half`
   placeability re-check; bounded concurrency.
4. **Visibility/persistence (R8/R18/R19, §5–§7):** persist `adversaryUnavailable` +
   reason on the proposal `decision`; amber badge in `app/console/components/approval-card.tsx`;
   notification payload flag; record Red-Team rejections as rows.
5. **Tests + verify gate + handoff docs.**

## Status
- DONE: audit, AGENTS.md rule + Slack announce, spec-doc stamp + owner-revision banner,
  this rollout note.
- DONE — **Stage 1a: resolution layer → no defaults** (owner's core rule). `resolveOpenAiModel`
  returns "" (not `OPENAI_MODEL` env / `DEFAULT_OPENAI_MODEL`) when Green unset; `resolveRoleModel`
  returns "" for an unset Red (no green fallback, no cross-family default); removed
  `CROSS_FAMILY_RED_TEAM_DEFAULT` + `defaultCrossFamilyRedTeamModel` + the userId param. Tests
  rewritten to the new contract. Added shared `extractJsonPayload` (R9) + tests.
- DONE — **chat de-default**: removed the hardcoded chat model defaults (`DEFAULT_OPENAI_MODEL` and
  `"claude-opus-4-8"`) from `app/api/chat/route.ts` (`llmFromProvider`) and `src/lib/chat/llm.ts`
  (`getLLM`); the chat model must now be an explicit per-request model or `CHAT_LLM_MODEL`, else
  MockLLM. Deleted `DEFAULT_OPENAI_MODEL` entirely (zero users).
- DONE — **policy-save validation** (`app/api/policy/route.ts`): stopped silently deleting a blank
  Red model (no more implicit fallback); added server-side keyed-provider backstop — a chosen
  Green/Red model must belong to a provider the user holds a key for; same-model allowed.
- NEXT (this effort, staged): **1b-remaining** — runtime fail-closed backstop in `strategy.ts` when a
  resolved model is "" (skip/route-to-human with a clear reason) + `app/console/settings/models.tsx`
  (both mandatory, keyed-providers-only *selectable*, same-model allowed, drop the "same as Green"
  empty option). **2** one adversary (delete in-flow Bear LLM in `proposeTrades`, rewrite
  `debateProposal` to do both jobs, kill `RED_TEAM_LLM_PROVIDER`). **3–4** reliability/visibility
  (R1–R20). **5** tests + verify + handoff docs.
- VERIFY-ITEMS for the landing lane: (1) `usage-budget.ts:376` tolerates greenModel==="". (2) The
  keyed-provider policy check requires `resolveLlmCredential`/`llmModelFamily` — confirm no import
  cycle (`app/api/policy` → `@/lib/llm-provider` → `@/lib/db`). (3) Existing tests/fixtures that PUT a
  policy with a model but no matching key will now 400 — update fixtures.
- Delivery: edited in the mounted `main` worktree (Cowork session can't reach the
  `agent/claude` lane or pull; base is 12 commits behind `origin/main`). **Cowork sandbox can't run
  the verify gate** (linux-arm64 vs macOS-compiled `better-sqlite3`/`vitest`/rolldown bindings), so
  a gate-capable lane must run `tsc`/`lint`/`test`/`build` + `land.sh` + PR. VERIFY-ITEM for the
  lane: `usage-budget.ts:376` (`resolveOpenAiModel` → greenModel) now tolerates "" — confirm no
  throw. The CHAT assistant default (`DEFAULT_OPENAI_MODEL` in chat/llm.ts + app/api/chat) is
  intentionally left in this pass — flag to owner if he wants chat de-defaulted too.

## Files touched this session
Docs/tracking: `AGENTS.md` (drift rule), `docs/single-adversary-consolidation.md` (status +
owner-revision banners), `docs/EFFORT-LOG.md` (rows), this note, `IMPROVEMENTS-2026-07-07.md`
(finding #4 corrected).
Code (Stage 1a + R9): `src/lib/llm-request.ts` (resolveOpenAiModel no default; DEFAULT_OPENAI_MODEL
scoped to chat), `src/lib/llm-provider.ts` (resolveRoleModel no defaults; removed cross-family
default + userId param), `src/lib/llm-call.ts` (+`extractJsonPayload`), `test/llm-request.test.ts`,
`test/llm-provider.test.ts`, `test/llm-call-json-payload.test.ts` (new).

## Follow-ups / risks
- STATUS.md + `docs/EFFORT-LOG.md` row + `PLAN.md` + `docs/phase-7-strategy.md:65`
  status flip are due at land (no commit made this session).
- Safety-critical (real-money trade gate): implement in compiling, verified stages;
  never leave a half-wired gate.
