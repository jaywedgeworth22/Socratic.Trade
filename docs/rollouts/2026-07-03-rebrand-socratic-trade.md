# 2026-07-03 — Rebrand: Agentic Trading → Socratic Trade / socratictrade.com

## Summary
The owner stood up production infrastructure under the name **Socratic Trade** at **socratictrade.com**
and asked to align the codebase to it. External infra was already done owner-side: the Sentry project
was named "socratic trade" from the start, `socratictrade.com` is pointed via Cloudflare, the GitHub
OAuth config + Google authorized domains were updated. `socratic.trade` also resolves but does not need
wiring — it doubles as the no-space form of the name.

Branch `claude/rebrand-socratic-trade`, off `origin/main` after #339 merged (so it carries the
VITEST-gated `isTradingDay` seam and is CI-green).

## What changed
**Display brand — "Agentic Trading" → "Socratic Trade":**
- `app/manifest.ts` — `name` "Socratic Trade"; `short_name` "Socratic.Trade" (the no-space form the
  owner endorsed for compact contexts); `description`.
- `app/layout.tsx` — `applicationName`, `appleWebApp.title`, meta `description`.
- `app/mobile/page.tsx` — `description`; `app/mobile/mobile-pwa-client.tsx` — the header `<h1>`.

**Public host fallback — `https://trading.jays.services` → `https://socratictrade.com`** (env-first:
`NEXT_PUBLIC_SITE_URL` / `x-forwarded-host` still take precedence; this is only the hardcoded default):
- `src/lib/public-origin.ts`, `app/robots.ts`, `app/sitemap.ts`, `app/layout.tsx` (`metadataBase`),
  `README.md` (production URL + Robinhood-callback example), and the `test/mcp-oauth.test.ts` /
  `test/logout-route.test.ts` fixtures (they use a concrete public host as a stand-in; updated for
  internal consistency — the tests assert env-driven behavior, not the fallback).

**Sentry project slug fallback — `agentic-trading` → `socratic-trade`** (`next.config.mjs`): the owner
named the Sentry project "socratic trade" from the start, so the fallback now matches reality. `org`
(`jays-services`) and `SENTRY_ORG`/`SENTRY_PROJECT` env overrides are unchanged.

## Deliberately NOT changed (and why)
- **`mail@jays.services`** — the owner's LOGIN email (`middleware.ts`, `src/lib/auth/identity.ts`,
  `app/welcome/page.tsx`, `app/how-it-works/page.tsx` mailto). `jays.services` is both a hostname and
  the owner's email domain; changing the email would lock the owner out of auth. Left every
  `mail@jays.services` occurrence intact — the rebrand only touched `trading.jays.services` HOSTNAMES.
- **Internal machine slugs** that happen to contain `agentic-trading`: telemetry `SOURCE_APP`
  (`usage-monitor-push.ts`), the notify `user-agent`/`source` (`notify.ts`), the mcp-oauth client
  identity (`mcp-oauth.ts`), and the account-deletion HMAC salt fallback
  (`"agentic-trading-account-deletion"`). These are telemetry-grouping / OAuth-registration /
  audit-hash identifiers, not the public brand — rebranding them would split telemetry history, change
  the Robinhood OAuth client name, or alter existing audit hashes. Left as-is.
- **The Robinhood account nickname "Agentic"** (`dashboard-client.tsx`, `connected-accounts/route.ts`,
  `robinhood.ts`) — the label the owner puts on the Robinhood account so the app detects it; an
  account-detection convention, not the product name.
- **Internal `jays.services` preview/beta subdomains** (`trading-beta`, `codex`/`claude`/`antigravity`
  previews) — the owner's local multi-agent dev infra, unchanged.
- The generic **"Trading Dashboard"** title / OG `siteName` — a secondary identity the app already kept
  distinct from the "Agentic Trading" brand; preserved that split rather than overreach into an SEO
  title decision the owner didn't ask for.

## Why
Owner's most recent explicit request: align the app to the Socratic Trade identity now that the domain,
Sentry project, and OAuth are set up externally. The surgical scope (public brand + host fallback +
Sentry slug only) avoids the `jays.services` email trap and internal-identifier churn.

## Files
`app/manifest.ts`, `app/layout.tsx`, `app/mobile/page.tsx`, `app/mobile/mobile-pwa-client.tsx`,
`src/lib/public-origin.ts`, `app/robots.ts`, `app/sitemap.ts`, `next.config.mjs`, `README.md`,
`test/mcp-oauth.test.ts`, `test/logout-route.test.ts`. Docs: `STATUS.md`, `docs/EFFORT-LOG.md`, this
rollout note.

## Verification
`npx tsc --noEmit`, `npm test` (full suite), `npm run build`, `npm run lint` — run before push (results
recorded in the commit / PR). No `mail@jays.services` occurrence altered (confirmed by grep). No
`trading.jays.services` hostname remains in `app/`/`src/`/`test/` (confirmed by grep).

## Follow-ups
- If the owner later wants the internal jays.services preview subdomains renamed, or telemetry
  `SOURCE_APP` / OAuth client name rebranded, that's a separate, explicit change (telemetry/OAuth
  continuity trade-offs called out above).
- If production is fully cut over to socratictrade.com (not just Cloudflare-fronted), confirm
  `NEXT_PUBLIC_SITE_URL` is set to `https://socratictrade.com` in the prod env so the fallback is never
  relied on.
