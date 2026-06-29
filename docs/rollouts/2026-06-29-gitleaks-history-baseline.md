# 2026-06-29 - Gitleaks scheduled history baseline

## Summary

- Added `.gitleaksignore` with the 10 exact historical fingerprints reported by
  the scheduled Security workflow's full-history gitleaks run.
- Updated handoff and security docs to explain that the baseline is narrow and
  future non-baselined findings must still fail CI.

## Why

Push and PR Security runs are green, but scheduled Security runs execute
`gitleaks detect` against the full repository history. Once the self-hosted
runner temp-file cleanup allowed the pinned action to complete, the weekly
full-history scan surfaced old fingerprints from historical commits. Baseline
those exact fingerprints instead of loosening rules or reducing scan scope.

## Files

- `.gitleaksignore`
- `STATUS.md`
- `PLAN.md`
- `docs/ops-observability-security.md`
- `docs/phase-11-multi-user.md`
- `docs/rollouts/2026-06-29-gitleaks-history-baseline.md`

## Verification

- `gitleaks detect --redact -v --exit-code=2 --log-level=debug` - passed;
  gitleaks found `.gitleaksignore`, skipped the 10 listed fingerprints, and
  reported `no leaks found`.
- `npm run lint` - passed; existing warnings only (`0 errors, 240 warnings`).
- `npx tsc --noEmit` - passed.
- `npm test` - passed, 157 files / 1,516 tests.
- `npm run build` - passed; Next.js emitted the existing
  middleware-to-proxy deprecation warning.

## Follow-ups

- If a future scheduled run reports new fingerprints, inspect them as new
  findings. Add to `.gitleaksignore` only when the underlying historical finding
  is understood and intentionally accepted.
