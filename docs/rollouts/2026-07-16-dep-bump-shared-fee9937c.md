# 2026-07-16: Bump congress-trading-shared to fee9937c

## Summary

Bumped `@jaywedgeworth22/congress-trading-shared` from `ef17b72` to `fee9937c25db1de75c1a676826801e3399f36106` in both `package.json` and `package-lock.json`, including the npm `allowScripts` entry.

## Why

Keep the shared-contract dependency current. The new commit includes the company-name standardization support needed by the `antigravity/company-name-standardization-part2` branch's feature work.

## Files

- `package.json` — dependency ref + allowScripts entry updated to `fee9937c`
- `package-lock.json` — regenerated lockfile reflecting the new commit

## Verification

- `npx tsc --noEmit` — clean
- `npm test` — clean (after merge with origin/main)
- `npm run build` — clean

## Follow-ups

None — this is a routine dependency bump. The feature work that consumes the new shared-contract API lands via the parent `antigravity/company-name-standardization-part2` branch.
