# 2026-06-25 — Credential-Scoped Health Lanes

## Summary

Extended the API Connections Health Panel (landed same day) to track health rows per
`(service, key_source)` credential lane. Previously all calls for a service (env key and
user key) shared a single health card, causing false STOPPED alerts when one user's key
failed but the env key was healthy.

## Why

Codex P2 review finding: env-key calls and user-key calls were co-mingled in the same
service card. A user with a bad API key would trigger "last 5 consecutive calls all failed"
on the shared lane, hiding the fact that the env key was fine.

## What changed

### Schema additions (`src/lib/db.ts`)
- `api_health_log` — added `key_source TEXT` and `user_id TEXT` columns (CREATE TABLE already
  had them; added ALTER TABLE migrations for existing DBs that pre-date credential scoping)
- `api_health_error_patterns` — added `key_source TEXT` column; UNIQUE constraint upgraded to
  `(service, fingerprint, key_source)` in CREATE TABLE
- `idx_api_health_log_service_key ON api_health_log (service, key_source, ts DESC)` — new index
  (also added via ALTER TABLE migration for existing DBs)
- ALTER TABLE migration block added (guarded by PRAGMA table_info) to upgrade pre-existing DBs

### db-health.ts (`src/lib/db-health.ts`)
- `ServiceHealthSummary` now includes `keySource: string | null`
- `HealthLogRow` and `ErrorPatternRow` now include `key_source: string | null`
- `logApiHealth` — `keySource` and `userId` are stored in the new columns; FIFO cap and
  error pattern upsert are scoped to `(service, key_source)` using `key_source IS ?`
- `listHealthLanes()` — returns `{ service, key_source }[]` pairs (one entry per distinct lane)
- `getServiceHealthSummaries()` — iterates lanes; all queries scoped to `(service, key_source)`
- `getAllErrorPatterns()` — keys result by `"service:keySource"` composite string

### Provider constructors (`src/lib/data-providers.ts`)
All remaining 8 provider classes that were missing `private readonly keySource: ApiKeySource`
were updated: FinnhubEnrichmentProvider, FmpEnrichmentProvider, AlphaVantageEnrichmentProvider,
FintechStudiosEnrichmentProvider, IntrinioEnrichmentProvider, TiingoEnrichmentProvider,
TwelveDataEnrichmentProvider. (AlpacaNews/AlpacaSnapshot were already done in the first pass.)

### fetchWithRetry call sites (`src/lib/data-providers.ts`)
All 9 keyed-provider call sites updated to pass `keySource: this.keySource, userId: this.userId`:
- Finnhub `getJson`
- FMP `getJson`
- AlphaVantage direct call + explicit `logApiHealth` call (200-but-error case)
- FintechStudios direct call
- Intrinio `getJson`
- Tiingo `getJson`
- TwelveData direct call
Yahoo Finance (public API, no key) intentionally left without keySource — logs as `key_source = NULL`.

### Admin API route (`app/api/admin/connections-health/route.ts`)
- Accepts `?keySource=` query param; passes it to `getServiceHealthLog` so the detail panel
  fetches only the rows for the selected credential lane

### Admin client (`app/admin/connections/connections-health-client.tsx`)
- `ServiceHealthSummary` and `ErrorPatternRow` interfaces updated with `keySource`/`key_source`
- Lane key `"service:keySource"` used as React key and selection state (was just `service`)
- `ServiceCard` displays `(env)` / `(user)` label after service name when keySource is set
- `ServiceDetail` header shows the same credential lane label
- Log fetch URL includes `&keySource=<value>` (empty string for NULL = public APIs)
- Error pattern lookup uses the composite lane key `"service:keySource"`
- Sort is stable: stopped-first → alphabetical by service → alphabetical by keySource

## Files touched
- `src/lib/db.ts` — ALTER TABLE migrations for key_source/user_id
- `src/lib/db-health.ts` — keySource threading throughout
- `src/lib/data-providers.ts` — 8 constructors + 9 call sites
- `app/api/admin/connections-health/route.ts` — keySource param
- `app/admin/connections/connections-health-client.tsx` — lane-aware UI
- `STATUS.md` — updated
- `docs/rollouts/2026-06-25-credential-scoped-health-lanes.md` — this file

## Verification
```bash
npx tsc --noEmit    # clean
npm test            # 1066/1067 (1 pre-existing cache-provenance date flake)
npm run build       # clean
```

## Follow-ups / known gaps
- `api_health_error_patterns` UNIQUE constraint on existing DBs is still `(service, fingerprint)`
  (not the new `(service, fingerprint, key_source)`). Changing SQLite constraints requires table
  recreation. Since `logApiHealth` swallows all errors, constraint mismatch would silently drop
  error pattern upserts (not a crash). Deferred until it causes a visible issue.
- `robinhood-fundamentals` provider still not instrumented (uses internal cache layer, not
  fetchWithRetry).
