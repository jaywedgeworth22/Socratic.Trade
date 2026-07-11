# 2026-07-11 — Admin server Hetzner response-shape crash fix

## Summary

- Fixed the production `/admin/server` React error #31 caused by rendering Hetzner response
  objects as text.
- Normalized `server_type.name` and `public_net.ipv4.ip` at the API boundary while retaining
  compatibility with the earlier flattened fixture shape.
- Added explicit provider-shape warnings and a client-side final guard that renders a diagnostic
  string rather than passing malformed runtime JSON to React.
- Normalized Coolify resource rows before calling string methods/rendering their fields.
- Removed fabricated local resource rows and metric histories; unconfigured/error paths now
  report real local host metadata and empty remote-only datasets.
- Preserved the API's real local-host receipt on non-2xx provider responses instead of dropping
  it on the client's first load.
- Replaced the metrics parser's `any` boundary with checked record/tuple parsing.

## Why

The original test represented `server_type` as `"cx33"` and omitted `public_net`, but Hetzner's
real API returns `server_type: { name: "..." }` and `public_net.ipv4: { ip: "..." }`. The route
forwarded those objects as `hostInfo.serverType` and `hostInfo.ip`; JSX then attempted to render
them and production crashed with React minified error #31.

## Files

- `app/api/admin/server-metrics/route.ts` — pure Hetzner response normalizer, checked metrics
  parser integration, normalized host payload, and provider-shape warnings.
- `app/admin/server/server-metrics-client.tsx` — defensive display-string guard and visible
  provider warning receipt.
- `src/lib/server-metrics-shapes.ts` — pure checked provider-shape parsers shared by the route
  and regression tests, including string-only Coolify resource normalization.
- `test/server-metrics.test.ts` — real Hetzner-shaped fixture plus malformed-provider regression
  coverage.
- `STATUS.md` — current fix status and next action.
- `docs/EFFORT-LOG.md` — branch reservation and in-progress state.
- `docs/rollouts/2026-07-11-admin-server-shape-fix.md` — this note.

## Verification

- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm ci --no-audit --no-fund` — passed; 760 lockfile
  packages installed in the isolated worktree.
- `npx vitest run test/server-metrics.test.ts` — passed, 1 file / 6 tests.
- `npx eslint app/api/admin/server-metrics/route.ts app/admin/server/server-metrics-client.tsx src/lib/server-metrics-shapes.ts test/server-metrics.test.ts`
  — passed with 0 errors and one pre-existing `react-hooks/set-state-in-effect` warning at
  `server-metrics-client.tsx:112`.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint` — passed with 0 errors / 376 warnings.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit` — passed.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm test` — passed, 318 files / 3,491 tests.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run build` — passed. Next.js emitted the existing
  Sentry Edge Runtime warning for `process.features` and the middleware deprecation warning.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH bash scripts/land.sh` — passed after removing only a
  corrupt ignored `.next/dev` generated cache left by the stopped dev server: typecheck clean,
  318 files / 3,491 tests passed, build clean, branch pushed, READY PR #1400 opened.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run dev -- --port 4301`; `curl` checks returned
  HTTP 200 for `/admin/server` and `/api/admin/server-metrics`. The API returned real Darwin host
  metadata plus empty `resources` and empty metric arrays with no provider credentials configured.
- In-app Browser initialization returned `No browser is available`, so a rendered interaction and
  console-log check could not be completed in this environment. No Playwright substitute was used.
- `git diff --check` — passed.

The initial dependency attempt before the serialized gate was killed with exit 137 and a temporary
lower-memory install omitted `@jaywedgeworth22/congress-trading-shared`. The clean Node 24 lockfile
install above repaired the isolated worktree, and the complete verification quartet then passed.

Post-PR integration receipt: after `origin/main` advanced through #1397 and #1399, a manual
`git merge --no-commit --no-ff origin/main` completed without textual conflicts. Both sides had
changed only `STATUS.md` and `docs/EFFORT-LOG.md` in common; Git retained both independently added
sections. No source file in this fix overlapped with the incoming source changes. Verification,
commit, and push were intentionally deferred while another lane held the serialized human-tree gate.

## Follow-ups

- Re-run the serialized Node 24 gate for the merged `origin/main`, then commit and push the merge to
  READY PR #1400. Do not merge or enable auto-merge.
- Render-check `/admin/server` through the in-app Browser when a Browser backend is available.
- No `PLAN.md` change: this is a production bug fix within the existing admin metrics scope, not
  a roadmap or approach change.
