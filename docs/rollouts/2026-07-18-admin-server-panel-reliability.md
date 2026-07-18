# Admin server panel reliability

## Scope

Bounded repair of `/admin/server` and `/api/admin/server-metrics`. No Cloudflare, Hetzner, Coolify, secret, deployment, or production-data state was changed.

## Behavior

- Hetzner and Coolify are configured and queried independently. Partial configuration is explicit and remote target data is never replaced with local process telemetry.
- Provider errors return HTTP 200 degraded JSON while preserving fields from successful provider calls. Missing fields remain absent and render as unavailable.
- Hetzner network parsing supports current `network.*.bandwidth.in` and `.out` names while retaining `.rx` / `.tx` compatibility.
- Hetzner aggregate CPU is divided by a positive core count from server metadata (or Coolify metadata fallback). Without a verified core count, CPU samples are omitted with a warning.
- A module-level one-entry cache uses a 120-second TTL and single-flight refresh. Total outages retry after 30 seconds and can serve the last successful snapshot for at most 10 minutes; `asOf`, cache age, and stale state are exposed to the client.
- The panel distinguishes local, remote, degraded, and stale states and displays the snapshot timestamp. `SERVER_METRICS_TARGET_ENVIRONMENT=production` is the only way to label a remote target as production; `NODE_ENV` controls local-runtime fallback only.

## Verification

- `vitest run test/server-metrics.test.ts`: 13 tests passed.
- `npm test`: 412 files / 4,800 tests passed on the exact amended commit.
- `tsc --noEmit`: passed.
- `eslint app/api/admin/server-metrics/route.ts app/admin/server/server-metrics-client.tsx src/lib/server-metrics-runtime.ts src/lib/server-metrics-shapes.ts test/server-metrics.test.ts`: passed.
- `npm run build`: passed with Next.js 16.2.10 webpack production build.
- `git diff --check`: passed.

## Release state

Committed on `codex/socratic-infra-panel-reliability` for review. Not pushed, opened as a PR, merged, or deployed.
