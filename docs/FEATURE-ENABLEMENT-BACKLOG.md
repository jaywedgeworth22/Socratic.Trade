# Feature enablement backlog (default-off / dormant / gated)

**Owner reminder (2026-07-22):** shipping code with feature flags **off** is intentional for
merge safety, but **default-off is not “done forever.”** This file is the living checklist of
capabilities that exist in the tree (or land soon via open PRs) but are **not yet product-live**
until someone deliberately enables them (env / Infisical / policy / subscription / rights gate).

**2026-07-24 owner enablement (CURSOR):** Priority A safe RAG retrieval flags flipped to
**default ON** in code + `.env.example` (unset == on). Explicit `=off` still disables. High-cost
and rights-gated items remain OFF. Pair prod Infisical with the same ON values when present so
operators can still override.

Update this file when you add a new default-off switch. Pair enablement with a rollout note +
prod exact-SHA verify. Do **not** purge legacy vectors until unscoped re-embed is verified.

Canonical effort-board rows: `/Users/jay/apps/TRADING-EFFORT-LOG.md` (Planned) +
`docs/EFFORT-LOG.md`.

---

## Priority A — RAG / retrieval (PR #1892 program + related)

**#1892 MERGED 2026-07-23.** Owner-directed enablement 2026-07-24:

| Flag / gate | Default | What it does when on | Status |
|-------------|---------|----------------------|--------|
| `RAG_CORPUS_WIDE_LEXICAL` | **ON** | FTS5 corpus-wide lexical recall fused with dense | Enabled 2026-07-24 |
| `HYBRID_RETRIEVAL` | **off** | Older hybrid path | Prefer lexical; keep off |
| `RAG_ADAPTIVE_RERANK` | **ON** | Adaptive overfetch depths by intent | Enabled; no-ops without rerank credentials |
| `RAG_RERANK_PROVIDER` | unset | Explicit openrouter/siliconflow rerank route | Set only with key + budget headroom |
| `RAG_PARENT_CONTEXT_EXPANSION` | **ON** | Bounded parent context on final survivors | Enabled 2026-07-24 |
| `RAG_APPLY_DEFAULT_FLOORS` | **ON** | Cosine/relevance/dedupe floors | Enabled 2026-07-24 |
| `RAG_MULTIQUERY` | **off** | Facet sub-queries per filings pass | Keep off (cost) |
| `RAG_HYDE` | **off** | HyDE hypothetical-doc embed | Keep off (cost) |
| `RAG_RUN_BUDGET_ENABLED` | **ON** | Per-run paid-stage budget ceiling | Enabled as guardrail |
| `RAG_RETRIEVAL_TELEMETRY` | **ON** | Retrieval quality telemetry | Enabled |
| `RAG_RETRIEVAL_STAGE_TELEMETRY` | **ON** | Per-stage duration/candidate receipts | Enabled |
| `RAG_PERSIST_CANDIDATE_POOL` | **off** | Persist candidate pool rows | Diagnostics only |
| `RAG_PERSIST_CANDIDATE_POOL_FULL` | **off** | Full pool persistence | Keep off |
| `RAG_CITATION_STALENESS` | **ON** | Citation staleness checks | Enabled (advisory) |
| `VECTOR_ASOF_SERVER_FILTER` | **ON** | Server-side as-of filter (fail-open) | Enabled |
| `VECTOR_ASOF_STRICT` | **off** | Fail-closed undated/future | Keep off until data quality OK |
| `VECTOR_EMBED_CLEAN_TEXT` | **off** | Clean text before embed | Benchmark first |
| `RAG_EMBED_DISCLOSURES` | **off** | Embed disclosure corpus | Product decision |
| `WEB_SOURCE_SEC8K_FULL_BODY` | **off** | Full 8-K body ingest → RAG | Enable with FTS mirror + budget |
| `SEC_INGEST_WORKER_ENABLED` | **off** | Background SEC ingest worker | Ops enable after queue health |
| **bge-m3 corpus re-embed → purge-legacy** | incomplete | Managed space full; legacy purge | **Do not purge** until unscoped re-embed verified |

---

## Priority B — Market data / sources (dormant until key, rights, or flag)

| Capability | Gate | Notes |
|------------|------|--------|
| FMP earnings transcripts | `WEB_SOURCE_FMP_TRANSCRIPTS` + `FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED` both off | Dual gate; commercial rights required |
| FMP price targets | `FMP_PRICE_TARGETS_ENABLED=off` | Extra call per symbol |
| EarningsCalls.dev | key present / free plan subscription; can be disabled via `EARNINGSCALLS_DISABLED` | Self-activates when entitled; monthly budget hard |
| RapidAPI enrichment tier | `RAPIDAPI_KEY` unset → dormant | Mboum / YH Finance 15 / AV-RapidAPI after free Yahoo |
| Massive short interest | `MASSIVE_API_KEY` + `MASSIVE_SHORT_INTEREST_ENABLED` | Inert without key |
| Quiver enrichment | `QUIVER_API_KEY` | Never registered without key |
| Webull unofficial | `WEBULL_UNOFFICIAL_ENABLED=off` | Unofficial path |
| Congress share outbound | `CONGRESS_SHARE_ENABLED=off` (+ fundamentals subflag) | Cross-app share |
| Alpaca price event streams | `STREAMS_ALPACA_PRICE_EVENTS_ENABLED` unset | Streaming |

---

## Priority C — Ops / safety / product surfaces

| Capability | Gate | Notes |
|------------|------|--------|
| Usage-budget hard enforce | `USAGE_BUDGET_ENFORCE=off` | Soft vs hard skip of strategy work |
| Infisical primary bridge writer | `INFISICAL_ST_PRIMARY_WRITER_ENABLED=false` | Usage-monitor primary credentials |
| Landing / welcome page | `LANDING_PAGE_ENABLED` unset → off | Marketing surface |
| CSP headers | CSP default-off unless enabled | Security hardening |
| Sentry session replay | `NEXT_PUBLIC_SENTRY_REPLAY_ENABLED=false` | Privacy/cost |
| Dev background workers | `DEV_BACKGROUND_WORKERS=off` | **Keep off** in local UI QA (intentional) |
| Robinhood broker-held stops | `policy.robinhoodBrokerStops` default off | Per-account policy, not env |
| Simulated fill cost model | default off | Paper/Test path |
| Apple Sign-In (web) | needs `AUTH_APPLE_ID` / `AUTH_APPLE_SECRET` | Configured code, owner secrets |
| Kalshi / options / short-sell capability program | dormant per-account double gates | Phase 1 design landed; product enable later |

---

## Priority D — Cross-app (remind on other boards too)

| App | Dormant / gated themes |
|-----|------------------------|
| Congress.Trade | Mobile parity PRs; FMP Senate recovery docs; security-bundle integration; audit fix trains — enable only after merge+verify |
| API-usage-monitor | Oracle cutover / writer ownership (owner go); iOS improvements PR; R2/storage entitlements |
| congress-trading-shared | Consumer pin upgrades; classifier enrichment contract — no “flags,” but pin lag leaves features unused |
| Fleet infra | Litestream R2 entitlement; Mac runners banned; Coolify CI capacity |

---

## How agents should use this

1. When landing a default-off feature, **add a row here** and a **Planned** effort-log line:  
   `Enable <flag> in production after <precondition>`.
2. When the owner asks “what are we not using?”, point here first.
3. Enabling in prod = Infisical/env change **and/or** code-default flip + health/receipt check + rollout note.
4. Do not enable high-cost or rights-gated flags without an explicit owner decision.

Inventory first cut: GROK 2026-07-22 from `.env.example` + `envFlagOn(..., false)` + known program docs.
Re-scan after large RAG/provider merges. Owner enablement pass: CURSOR 2026-07-24.
