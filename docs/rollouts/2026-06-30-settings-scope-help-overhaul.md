# 2026-06-30 - Settings scope and help overhaul

## Summary
- Added compact help buttons to the shared form field primitive so Settings option explanations work on hover, focus, and tap without long inline prose.
- Moved the Strategy Studio entry point from User -> Connections to Account -> Strategy, and fixed Settings initialization so account sections open on the Account side.
- Made Strategy Studio model and reasoning-effort fields account-scoped instead of user-scoped, while preserving older user-level model choices as a one-time account seed.
- Added a Settings Glossary in System Help, including the "Min lots for weight shift" explanation.

## Why
Strategy prompt, model choices, reasoning effort, scoring weights, and tuning reviews govern a selected account strategy. Provider API keys are user-owned credentials. The UI and persistence split now match that model, and advanced settings can be explained without expanding every Settings tab with bottom text.

## Files
- `app/ui/primitives.tsx`
- `app/dashboard-client.tsx`
- `src/lib/db-profiles.ts`
- `src/lib/types.ts`
- `test/per-account-policy-isolation.test.ts`
- `test/persistence-notification.test.ts`
- `docs/phase-11-multi-user.md`
- `docs/rollouts/2026-06-29-tiered-settings.md`
- `STATUS.md`
- `PLAN.md`
- `docs/rollouts/2026-06-30-settings-scope-help-overhaul.md`

## Verification
- `bash scripts/npm-ci-with-shared-deps.sh` - passed; installed fresh worktree dependencies for the private shared package path.
- `npm test -- test/per-account-policy-isolation.test.ts` - passed, 10 tests.
- `npm test -- test/persistence-notification.test.ts` - passed, 19 tests after rebasing onto the LLM timeout diagnostics changes; strategy-run LLM tests now seed a local user OpenAI key instead of depending on operator fallback env state.
- `npm run lint` - passed with 0 errors and 255 existing warnings.
- `npx tsc --noEmit` - passed.
- `npm test` - passed, 161 files / 1559 tests after the final rebase onto `origin/main`.
- `npm run build` - passed.
- `pm2 start npm --name trading-settings-help-overhaul -- run dev -- --port 4113 && pm2 save` - started a managed branch preview at `http://localhost:4113`.
- `curl --max-time 10 -i http://localhost:4113/api/health` - returned 200 with `{"ok":true}`.
- `curl --max-time 20 -I http://localhost:4113` - returned 200 after first-route dev compilation.

## Follow-ups
- Consider moving the Strategy tab's Key Parameters card fully into Account Settings so all account-level controls live in one modal.
- Split tax settings further if needed: account tax treatment is account metadata, while tax rates are taxpayer-level preferences.
- Audit remaining switch rows for `aria-labelledby` / `aria-describedby` once the Settings layout settles.
