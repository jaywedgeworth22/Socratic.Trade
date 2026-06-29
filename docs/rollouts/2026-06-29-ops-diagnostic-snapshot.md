# 2026-06-29 — Ops diagnostic snapshot API

## Summary
- Added `GET /api/ops/snapshot` — token-gated operational snapshot for remote agents/curl.
- Returns per-user: connected accounts (autonomy mode, LLM model, key configured flag),
  recent `strategy_runs` with `connectedAccountId` + label, and recent ops-relevant audit rows.
- Middleware: `/api/ops` added to `PUBLIC_PREFIXES`; auth is token-only inside the handler.

## Why
- Cursor cloud agent cannot OAuth into `trading.jays.services` or read `data/app.db` on the Mac.
- Needed a safe way to inspect production strategy-run failures and per-account state remotely.

## Files
- `app/api/ops/snapshot/route.ts`
- `src/lib/ops-auth.ts`
- `src/lib/ops-snapshot.ts`
- `middleware.ts`
- `.env.example`
- `test/ops-snapshot.test.ts`
- `STATUS.md`, `docs/rollouts/2026-06-29-ops-diagnostic-snapshot.md`

## Verification
- `npx vitest run test/ops-snapshot.test.ts` — 2 passed
- `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build` — run before merge

## Production setup (owner)
1. Generate a long random token: `openssl rand -hex 32`
2. Set `OPS_DIAGNOSTIC_TOKEN` on `trading-live` (Infisical prod / `.env.local`)
3. Restart pm2 `trading`
4. Probe:
   ```bash
   curl -sS -H "x-ops-token: $OPS_DIAGNOSTIC_TOKEN" \
     "https://trading.jays.services/api/ops/snapshot?runs=15&audit=30" | jq .
   ```
5. Optional: add the same token as a Cursor Cloud secret so agents can call the endpoint.

## Follow-ups
- Fix `getAlpacaGateway` to use the run target's connected account (multi-account scheduler bug).
- Add account column to dashboard Runs tab once broker fix lands.
