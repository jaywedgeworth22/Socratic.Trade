# Feature enablement backlog (default-off / dormant / gated)

**Owner reminder (2026-07-22):** shipping code with feature flags **off** is intentional for
merge safety, but **default-off is not “done forever.”** This file is the living checklist of
capabilities that exist in the tree (or land soon via open PRs) but are **not yet product-live**
until someone deliberately enables them (env / Infisical / policy / subscription / rights gate).

Update this file when you add a new default-off switch. Pair enablement with a rollout note +
prod exact-SHA verify. Do **not** flip money-path RAG/retrieval flags until corpus re-embed and
eval receipts are green.

Canonical effort-board rows: `/Users/jay/apps/TRADING-EFFORT-LOG.md` (Planned) +
`docs/EFFORT-LOG.md`.

---

## Priority A — RAG / retrieval (PR #1892 program + related)

**#1892 MERGED 2026-07-23.** Flags still remain off. Owner wants an explicit **enable after
merge + prove** pass, not permanent dormancy.

| Flag / gate | Default | What it does when on | Enable after / notes |
|-------------|---------|----------------------|----------------------|
| `RAG_CORPUS_WIDE_LEXICAL` | **off** | FTS5 corpus-wide lexical recall fused with dense | After #1892 live + FTS mirrors/backfill healthy; start shadow/eval |
| `HYBRID_RETRIEVAL` | **off** | Older hybrid path (related; confirm interaction with lexical) | Prefer new lexical path; audit before dual-on |
| `RAG_ADAPTIVE_RERANK` | **off** | Adaptive overfetch depths by intent | After cost/latency receipts OK; needs rerank credentials |
| `RAG_RERANK_PROVIDER` | unset | Explicit openrouter/siliconflow rerank route | Set only with key + budget headroom |
| `RAG_PARENT_CONTEXT_EXPANSION` | **off** | Bounded parent context on final survivors | After lexical+rerank stable; changes prompt content |
| `RAG_APPLY_DEFAULT_FLOORS` | **off** | Cosine/relevance/dedupe floors like strategy/chat | Eval already injects floors; consider prod on with #1892 |
| `RAG_MULTIQUERY` | **off** | Facet sub-queries per filings pass | Paid LLM/embed amplification |
| `RAG_HYDE` | **off** | HyDE hypothetical-doc embed (needs MULTIQUERY) | Highest cost tier; last |
| `RAG_RUN_BUDGET_ENABLED` | **off** | Per-run paid-stage budget ceiling | Worth enabling as guardrail when turning retrieval quality on |
| `RAG_RETRIEVAL_TELEMETRY` | **off** | Retrieval quality telemetry | Enable early for visibility (low risk) |
| `RAG_RETRIEVAL_STAGE_TELEMETRY` | **off** | Per-stage duration/candidate receipts | Enable early with quality program |
| `RAG_PERSIST_CANDIDATE_POOL` | **off** | Persist candidate pool rows | Diagnostics; privacy/size aware |
| `RAG_PERSIST_CANDIDATE_POOL_FULL` | **off** | Full pool persistence | Heavier; only if debugging |
| `RAG_CITATION_STALENESS` | **off** | Citation staleness checks | Enable with PIT hardening |
| `VECTOR_ASOF_SERVER_FILTER` | **off** | Server-side as-of filter | Enable with strict PIT |
| `VECTOR_ASOF_STRICT` | **off** | Fail-closed undated/future | Enable after data quality OK |
| `VECTOR_EMBED_CLEAN_TEXT` | **off** | Clean text before embed | Benchmark first |
| `RAG_EMBED_DISCLOSURES` | **off** | Embed disclosure corpus | Product decision |
| `WEB_SOURCE_SEC8K_FULL_BODY` | **off** | Full 8-K body ingest → RAG | Enable with FTS mirror + budget |
| `SEC_INGEST_WORKER_ENABLED` | **off** | Background SEC ingest worker | Ops enable after queue health |
| **bge-m3 corpus re-embed → purge-legacy** | incomplete | Managed space full; legacy purge | **Do not purge** until unscoped re-embed verified |

Suggested enable order (product):

1. Telemetry flags (`RAG_RETRIEVAL_TELEMETRY`, stage telemetry)  
2. Production-path eval run (allow-live, credentialed user) against frozen goldens  
3. `RAG_CORPUS_WIDE_LEXICAL` (+ ensure FTS rows for filings/8-K)  
4. Explicit rerank route if not already on embed path; then `RAG_ADAPTIVE_RERANK`  
5. `RAG_PARENT_CONTEXT_EXPANSION`  
6. Multi-query / HyDE only with budget + value proof  

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
3. Enabling in prod = Infisical/env change + health/receipt check + rollout note — **not** just merging code.
4. Do not enable by “helpfully” flipping defaults to `true` in code without an explicit owner decision.

Inventory first cut: GROK 2026-07-22 from `.env.example` + `envFlagOn(..., false)` + known program docs.
Re-scan after large RAG/provider merges.
