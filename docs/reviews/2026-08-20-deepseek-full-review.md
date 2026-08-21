# Full-Stack Review — Desktop Web + Mobile Web + iOS (DEEPSEEK, 2026-08-20)

Owner-directed top-to-bottom review of Socratic.Trade across the desktop website, the phone-width website, and the native iOS app.  This review complements (does not replace) the 2026-08-18 MONET expert review (`docs/reviews/2026-08-18-full-app-expert-review.md`), the 2026-08-17 architecture/backend and brokers/data-cascade audits (`docs/audits/`), and the open Kimi board findings.  Where a known finding was re-checked against current `main` (`41a7a438d` at review start), this document records the CURRENT state (fixed / still open / narrowed) so nobody re-files or re-fixes stale claims.

Board: umbrella item `682e7e3467cd4def97a13ee67335cbb1` (claimed by DEEPSEEK).  New findings are filed individually as `review-finding` items.

## 0. Method

- Four parallel review tracks, each grounded on the clean lane `~/apps/trading-deepseek` at `origin/main` HEAD `41a7a438d` (2026-08-20): desktop web (console), mobile web (phone viewports), iOS native app (Swift), backend/API/ops/docs.
- Live production measurements: HTTP headers, robots.txt, meta tags, Lighthouse (desktop + mobile) against `https://socratictrade.com/login`, `/api/health` sha vs `origin/main`.
- Cross-checked against the shared board (`board list --app socratic-trade --status open`) so no finding duplicates an open item; state-changes on open items are recorded here and on the board as comments.

## 1. Live production state (measured 2026-08-20 ~21:10–21:40 CDT)

- **Production is 8 commits behind `origin/main`.**  `/api/health` reports release sha `e0a4959a`; `origin/main` is `41a7a438d`.  Not-yet-live: #2973 (broker cancel/timeout), #2947 (Tradier paging), #2959 (intraday 502), #2817 (RTH deploy latch), #2974 (iOS/web parity), #2785 (favicon crop), #2795 (console chip AA), #2975 (effort log).  Consequence: several fixes below are NOT observable on the live site yet; any "verify live" step must re-check the sha first (`bash scripts/verify-deploy-sha.sh`).
- **Live `GET /icon.png` is still ~1.0 MB** (etag `W/"f4530-..."` ≈ 1,001,264 bytes) — the pre-crop icon.  `main`'s regenerated `public/icon.png` is 160 KB.  Deploying #2785 fixes this; until then the login page ships a 1 MB PNG as its largest asset.
- **The entire public surface is the sign-in page.**  `GET /` → 307 → `/login`; `robots.txt` disallows everything (`User-Agent: *` `Disallow: /`, plus explicit AI-crawler blocks); every page is `noindex, nofollow`.  There is no landing/marketing page, no public docs surface, no SEO presence.  Consistent with a single-operator app, but the owner should confirm this is intended (it also means the App Store listing is the only public marketing surface).
- **Security headers are strong:** HSTS (2y, preload), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, Cloudflare NEL.  **CSP is report-only** (`content-security-policy-report-only` with `'unsafe-inline' 'unsafe-eval'`) — worth a progressive-enforcement program (see findings).
- **Lighthouse (anonymous login page):** desktop perf 96 / a11y 100 / best-practices 96 (LCP 1.0 s, TBT 10 ms, CLS 0).  Mobile perf 66 / a11y 100 / BP 96 (LCP 8.3 s, TBT 250 ms, interactive 8.4 s).  The mobile gap is driven by the 1 MB `icon.png` (1.4 MB total page weight) plus ~330 KB of JS chunks with ~162 KiB unused.
- **Scheduler/broker health (live):** `/api/health` ok; scheduler ticking (age 32 s), 2 active accounts, 2 autopilot, market closed, `tradingLivenessDegraded: false`.  No live-watch issues observed.
- **Merge gate:** the `main-protection` ruleset requires exactly ONE status check: `verify` (tsc → vitest → next build).  `ios-build.yml` exists (Mac runner, unsigned build on `ios/**` PRs) but is NOT a required check — open board finding `830c892f` confirmed on current main.

## 2. State verifications of open board findings (as of main 41a7a438d)

| Board id | Finding | Current state on main |
|---|---|---|
| 89249c60 | Swift decoders drift from route payloads | **Specific defect FIXED**: `DeskModels.swift:368-373` decodes nested `riskRules` with top-level fallback.  Systemic part (no API→iOS contract test) still open. |
| 3b343933 | iOS shows previous account's data after sign-out | **Specific defect FIXED on main**: `MobileStore.swift:686` `signOut()` withdraws the push token and clears the local session (`clearLocalSession`).  Verify the shipped TestFlight binary carries it. |
| 830c892f | Merge gate never compiles iOS | **Confirmed still open**: only `verify` is a required check; `ios-build` is not in the ruleset.  Fix is a one-line ruleset change (add `ios-build` as required status check). |
| 410bda84 | iOS privacy manifest missing | **Confirmed still open**: no `PrivacyInfo.xcprivacy` anywhere in `ios/` (grep of `project.yml` + sources). |
| 2056ceab | Tone tokens fail WCAG AA | Partially addressed by #2795 (chip AA, live only after deploy); re-audit remaining tones after prod catches up. |
| LIVE-02 (expert review) | Bare 404 page inside console shell | **Confirmed still open**: no `app/not-found.tsx` / `app/console/not-found.tsx`; `/console/proposals` (nav label "Proposals" → `/console/approvals`) renders Next's stock 404. |

## 4. Prioritized fix/improvement outline (DEEPSEEK, current main)

Priorities: P0 = correctness/money-path/blocking; P1 = significant; P2 = polish/hygiene; P3 = nice-to-have; P4 = observation.  Open Kimi/expert-review items are referenced by board id / cluster key — this list does not re-file them; it adds what is NEW and orders the whole.

### P0 (money-path / correctness — mostly owned, reference only)
- The 12+ open P1 board findings from the Kimi audit are the money-path truth (broker I/O 28996d82, cancel-replace ownership 23f0ca01, quote asOf fabrication 009b99f0, approve-success misreport d2094c78, price-alert silence d97c8726, day-P&L flows 0706c22a, identity fail-open 6c36b9be, event-loop pins 937c3b0a/2967, RAG run hang 2961, migration PRAGMA check 2964, Alpaca socket leak 2970).  Nothing here supersedes them; the outline below assumes they land as claimed.

### P1 (significant — new or state-changed)
1. **Merge gate must compile the iOS app (state-changed).**  Confirmed on current main: the `main-protection` ruleset requires exactly `verify`; `ios-build.yml` exists but is not required.  One-line ruleset fix (add `ios-build` required status check) closes board 830c892f.  Effort: S.  This is the cheapest systemic win on the board.
2. **Production is 8 commits behind main — close the gap deliberately.**  Live sha `e0a4959a` vs `origin/main` `41a7a438d`; the not-yet-live set includes #2973 (broker cancel/timeouts), #2947 (Tradier paging), #2959 (intraday 502), #2974 (iOS/web parity), #2785 (favicon — the live 1 MB `icon.png`), #2795 (console chip AA), #2817 (RTH latch).  The RTH deploy latch deliberately pauses deploys in market hours; this backlog is the expected consequence, but the owner should verify the sha once the latch window opens (`bash scripts/verify-deploy-sha.sh`).  Effort: S (ops).
3. **CSP enforcement program.**  CSP is report-only with `'unsafe-inline' 'unsafe-eval'` (live headers).  Worth: monitor `report-uri /api/csp-report` for a week, then tighten incrementally (remove `unsafe-eval`, then inline).  Effort: M across the repo; P2 security value, listed P1 because it is the one live header weakness in an otherwise strong set.
4. **Mobile first-paint on the public surface.**  Lighthouse mobile on `/login`: perf 66, LCP 8.3 s, interactive 8.4 s vs desktop 96/1.0 s.  Drivers: 1 MB `icon.png` (fixed in main by #2785 but not deployed — after deploy re-measure), ~330 KB JS with 162 KiB unused, font loading.  Follow-ups: preload the LCP image, trim unused chunk code, consider AVIF/WebP for icons.  Effort: S-M.

### P2 (polish/hygiene)
5. **Custom 404 pages (confirmed still open).**  No `app/not-found.tsx` / `app/console/not-found.tsx`; `/console/proposals` (nav label "Proposals" → `/console/approvals`) renders Next's stock 404 with no chrome.  Fix: console-scoped not-found + redirect alias for `/console/proposals`.  Effort: S.
6. **iOS privacy manifest (confirmed still open, board 410bda84).**  No `PrivacyInfo.xcprivacy` in `ios/`; add the standard manifest (UserDefaults/network reasons) before the next TestFlight so the App Store review doesn't bounce.  Effort: S.
7. **Two-space sentence rule — finish the enforcement (in flight).**  `SENTENCE_GAP` exists in `app/console/lib/format.ts` and is used in `chrome.tsx`/`proposal-scorecard.tsx`; PR #2971 (monet/copy-rules-lint) is open to enforce the rest.  Verify iOS strings too (`UserFacingCopyTests.swift` covers some).  Effort: M (mostly mechanical).
8. **Light-theme default verified OK on web** (`useConsoleTheme` returns light on first visit; console-scoped key; `data-theme` never clashes with legacy `.dark`).  Keep the iOS app at light default too (verify the current binary).
9. **State updates for board findings already fixed on main:** 89249c60 (riskRules decoder now nests correctly — systemic contract-test part still open) and 3b343933 (sign-out clears the session snapshot on main).  Comment both on the board so the queue doesn't re-fix them.

### P3 (nice-to-have)
10. **Public landing surface (decision, not defect).**  `GET /` → 307 → `/login`, all pages `noindex`, robots disallows everything — the entire public web presence is the sign-in page.  For a single-operator app this is defensible; if the owner ever wants the App Store listing backed by a matching web story, a small public page (`/about` or a landing at `/`) with the same metadata already present in `app/layout.tsx` would be the minimal move.  Effort: S-M.
11. **`/console/proposals` alias** (folded into #5).
12. **Login-page asset hygiene**: the 1 MB icon and unused JS are the only real weight on the public page; after #2785 deploys, re-run Lighthouse mobile to confirm.

### P4 (observations)
13. Robots.txt blocks all AI crawlers — consistent with a private app; no change needed.
14. `viewport` meta, `themeColor` lockstep, `interactiveWidget: resizes-content` are all correct in `app/console/layout.tsx` — good mobile chrome hygiene.
15. The dashboard data layer (`useConsoleData.tsx`) has strong coalescing/abort discipline (SSE + poll + visibility gating + slow-load notice) — the "blocking snapshot" concern (board f61404ec) is partly mitigated; re-audit after prod catches up.

## 3. New findings (filed on the board)

<!-- populated from the four review tracks -->
