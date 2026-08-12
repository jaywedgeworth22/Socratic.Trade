/**
 * Declarative catalog of source / data-plane knobs that used to live only in Infisical/env.
 * Exposed in Settings so each user can select values; runtime resolve uses user override then env.
 *
 * Scope (owner 2026-08-06): FMP product modules + SEC/RAG/web-source/transcript knobs that
 * affect what data the app pulls. LLM model choice stays on Strategy. Infra secrets stay env-only.
 */

export type SourceSettingType = "boolean" | "number" | "string";

export type SourceSettingGroup =
  | "fmp"
  | "sec"
  | "web_sources"
  | "rag"
  | "transcripts"
  | "enrichment";

export interface SourceSettingSpec {
  /** Stable id — usually the env var name for 1:1 mapping. */
  id: string;
  group: SourceSettingGroup;
  label: string;
  description: string;
  type: SourceSettingType;
  /** Default when neither user override nor env is set. */
  defaultValue: boolean | number | string;
  /** Optional min/max for numbers. */
  min?: number;
  max?: number;
  /** When true, only primary/local operator should change (shown as advanced). */
  advanced?: boolean;
  /** Honest product note (e.g. retired network path). */
  caveat?: string;
}

export const SOURCE_SETTING_GROUPS: Record<
  SourceSettingGroup,
  { title: string; blurb: string }
> = {
  fmp: {
    title: "Financial Modeling Prep (FMP)",
    blurb:
      "Legacy module toggles. Direct FMP HTTP is still blocked in product code until/unless that ban is lifted — toggles persist so you can pre-select intent and so CT-class features stay visible."
  },
  sec: {
    title: "SEC EDGAR & filings RAG",
    blurb: "10-K/10-Q ingest cadence, 8-K depth, rate limits, and background backfill worker."
  },
  web_sources: {
    title: "Web sources",
    blurb: "Congress, insider Form 4, FINRA short volume, technicals — on/off and windows."
  },
  rag: {
    title: "RAG / retrieval",
    blurb: "Disclosure embed, multi-query, HyDE, candidate-pool diagnostics, run budget."
  },
  transcripts: {
    title: "Earnings transcripts",
    blurb: "ROIC, EarningsCalls.dev, and FMP transcript producers (quotas + entitlement)."
  },
  enrichment: {
    title: "Enrichment cascade",
    blurb: "Optional fundamentals/history sources beyond the free floors."
  }
};

/** All knobs the Settings UI may show and the API may write. */
export const SOURCE_SETTINGS_CATALOG: readonly SourceSettingSpec[] = [
  // ── FMP product modules (policy-backed historically; also in source map) ──
  {
    id: "fmpRealTimeDataEnabled",
    group: "fmp",
    label: "Real-time & index data",
    description: "FMP real-time quotes / index modules when product path is allowed.",
    type: "boolean",
    defaultValue: false,
    caveat: "ST hard-blocks direct FMP network calls today; toggle stores intent only until unblock."
  },
  {
    id: "fmpMacroDataEnabled",
    group: "fmp",
    label: "Macro & commodities",
    description: "FMP macro / commodity series.",
    type: "boolean",
    defaultValue: false,
    caveat: "ST hard-blocks direct FMP network calls today; toggle stores intent only until unblock."
  },
  {
    id: "fmpEventsDataEnabled",
    group: "fmp",
    label: "Events & news",
    description: "FMP calendar / events modules.",
    type: "boolean",
    defaultValue: false,
    caveat: "ST hard-blocks direct FMP network calls today; toggle stores intent only until unblock."
  },
  {
    id: "fmpFundamentalsDataEnabled",
    group: "fmp",
    label: "Deep fundamentals",
    description: "FMP ratios / statements modules.",
    type: "boolean",
    defaultValue: false,
    caveat: "ST hard-blocks direct FMP network calls today; multi-source cascade is the live path."
  },
  {
    id: "WEB_SOURCE_FMP_TRANSCRIPTS",
    group: "fmp",
    label: "FMP earnings transcripts (feature)",
    description: "Allow FMP transcript producer when storage rights are also confirmed.",
    type: "boolean",
    defaultValue: false,
    advanced: true
  },
  {
    id: "FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED",
    group: "fmp",
    label: "FMP transcript storage rights confirmed",
    description: "Owner confirms commercial rights to store/redistribute FMP transcript text.",
    type: "boolean",
    defaultValue: false,
    advanced: true,
    caveat: "Do not enable without a real rights agreement."
  },

  // ── SEC ───────────────────────────────────────────────────────────────────
  {
    id: "WEB_SOURCE_SEC8K",
    group: "sec",
    label: "SEC 8-K connector",
    description: "Index recent 8-K filings (summaries always; full body gated separately).",
    type: "boolean",
    defaultValue: true
  },
  {
    id: "WEB_SOURCE_SEC8K_FULL_BODY",
    group: "sec",
    label: "8-K full-body ingest",
    description: "Embed full 8-K HTML bodies into RAG (costly Voyage/Pinecone).",
    type: "boolean",
    defaultValue: false
  },
  {
    id: "WEB_SOURCE_SEC8K_FULL_BODY_LIMIT",
    group: "sec",
    label: "8-K full-body limit / cycle",
    description: "Max fresh 8-Ks that get full-body ingest per refresh.",
    type: "number",
    defaultValue: 5,
    min: 0,
    max: 100
  },
  {
    id: "WEB_SOURCE_SEC8K_RAG_LIMIT",
    group: "sec",
    label: "8-K RAG docs / refresh",
    description: "Cap on 8-K docs sent to embed per refresh cycle.",
    type: "number",
    defaultValue: 16,
    min: 1,
    max: 200
  },
  {
    id: "WEB_SOURCE_SEC8K_WINDOW_DAYS",
    group: "sec",
    label: "8-K lookback window (days)",
    description: "How far back to pull 8-Ks from EDGAR.",
    type: "number",
    defaultValue: 7,
    min: 1,
    max: 90
  },
  {
    id: "SEC_FILING_RAG_MAX_PER_RUN",
    group: "sec",
    label: "10-K/10-Q filings per run",
    description: "Max full 10-K/10-Q bodies to ingest per scheduler tick (paid Voyage).",
    type: "number",
    defaultValue: 25,
    min: 1,
    max: 5000
  },
  {
    id: "SEC_FILING_INGEST_TTL_HOURS",
    group: "sec",
    label: "Filing ingest recheck TTL (hours)",
    description: "How often to re-scan symbols for new 10-K/10-Q filings.",
    type: "number",
    defaultValue: 168,
    min: 1,
    max: 720
  },
  {
    id: "SEC_INGEST_WORKER_ENABLED",
    group: "sec",
    label: "SEC backfill worker",
    description: "Background job queue for large 10-K/10-Q backfills.",
    type: "boolean",
    defaultValue: false,
    advanced: true
  },
  {
    id: "SEC_RATE_LIMIT",
    group: "sec",
    label: "SEC requests / second",
    description: "Polite EDGAR rate limit (SEC asks for identification + pacing).",
    type: "number",
    defaultValue: 4,
    min: 1,
    max: 10,
    advanced: true
  },
  {
    id: "SEC_XBRL_ENRICHMENT_ENABLED",
    group: "enrichment",
    label: "SEC XBRL fundamentals enrichment",
    description: "Pull companyfacts XBRL into the fundamentals cascade.",
    type: "boolean",
    defaultValue: true
  },

  // ── Web sources ───────────────────────────────────────────────────────────
  {
    id: "WEB_SOURCE_CONGRESS",
    group: "web_sources",
    label: "Congressional trade feed",
    description: "House/Senate trade disclosures into the evidence stack.",
    type: "boolean",
    defaultValue: true
  },
  {
    id: "WEB_SOURCE_INSIDER",
    group: "web_sources",
    label: "SEC Form 4 insider feed",
    description: "Insider transaction rapid filings.",
    type: "boolean",
    defaultValue: true
  },
  {
    id: "WEB_SOURCE_FINRA",
    group: "web_sources",
    label: "FINRA short volume",
    description: "Short-sale volume series.",
    type: "boolean",
    defaultValue: true
  },
  {
    id: "WEB_SOURCE_TECHNICAL",
    group: "web_sources",
    label: "Computed technicals",
    description: "Local OHLC-derived technical indicators for scan candidates.",
    type: "boolean",
    defaultValue: true
  },

  // ── RAG ───────────────────────────────────────────────────────────────────
  {
    id: "RAG_EMBED_DISCLOSURES",
    group: "rag",
    label: "Embed disclosure / Form 4 narratives",
    description: "Send congressional/insider disclosure text into the vector corpus.",
    type: "boolean",
    defaultValue: false
  },
  {
    id: "RAG_MULTIQUERY",
    group: "rag",
    label: "Multi-query retrieval",
    description: "Facet sub-queries per filings pass (more embeds).",
    type: "boolean",
    defaultValue: false,
    advanced: true
  },
  {
    id: "RAG_HYDE",
    group: "rag",
    label: "HyDE passages",
    description: "Draft hypothetical filing snippets via LLM (requires multi-query).",
    type: "boolean",
    defaultValue: false,
    advanced: true
  },
  {
    id: "RAG_PERSIST_CANDIDATE_POOL",
    group: "rag",
    label: "Persist candidate-pool diagnostics",
    description: "Audit rows for retrieval candidate pools (DB growth).",
    type: "boolean",
    defaultValue: false,
    advanced: true
  },
  {
    id: "VECTOR_EMBED_CLEAN_TEXT",
    group: "rag",
    label: "Clean-text embedding revision",
    description: "Stamp embed_rev=2 cleaned text (reindex before treating corpus as one space).",
    type: "boolean",
    defaultValue: false,
    advanced: true
  },

  // ── Transcripts ───────────────────────────────────────────────────────────
  {
    id: "ROIC_TRANSCRIPTS_DISABLED",
    group: "transcripts",
    label: "Disable ROIC transcripts",
    description: "Kill-switch for ROIC earnings-call ingest (key can stay).",
    type: "boolean",
    defaultValue: false
  },
  {
    id: "ROIC_TRANSCRIPTS_MAX_PER_RUN",
    group: "transcripts",
    label: "ROIC transcripts per run",
    description: "Max transcript fetches per scheduler pass.",
    type: "number",
    defaultValue: 12,
    min: 1,
    max: 50
  },
  {
    id: "ROIC_HISTORY_ENABLED",
    group: "enrichment",
    label: "ROIC price history",
    description: "Use ROIC in the OHLC history cascade when key is present.",
    type: "boolean",
    defaultValue: true
  },
  {
    id: "EARNINGSCALLS_DISABLED",
    group: "transcripts",
    label: "Disable EarningsCalls.dev",
    description: "Kill-switch for EarningsCalls producer + retrieval.",
    type: "boolean",
    defaultValue: false
  },
  {
    id: "EARNINGSCALLS_DAILY_TARGET_TRANSCRIPTS",
    group: "transcripts",
    label: "EarningsCalls daily target",
    description: "New full transcripts to fetch on an ordinary day.",
    type: "number",
    defaultValue: 5,
    min: 0,
    max: 100
  },
  {
    id: "EARNINGSCALLS_BURST_MAX_TRANSCRIPTS",
    group: "transcripts",
    label: "EarningsCalls burst max",
    description: "Ceiling when a one-shot burst is armed.",
    type: "number",
    defaultValue: 25,
    min: 1,
    max: 100
  },

  // ── News relevance gating (DSA lesson: providers' own relevance scores were parsed then
  // thrown away, and providers with no native score attributed every headline that merely named
  // a symbol/company — even an ambiguous common word like "Apple" or "Target" with nothing
  // finance-related in the sentence). See src/lib/news-relevance.ts. ─────────────────────────
  {
    id: "NEWS_RELEVANCE_FILTER",
    group: "enrichment",
    label: "News relevance filter",
    description:
      "Keep only headlines/sentiment a provider (or, lacking a provider score, this app's own headline-text rubric) scores as actually about the symbol.  Off restores every headline a provider tags to the symbol, including ambiguous common-word company name matches.",
    type: "boolean",
    defaultValue: true
  },
  {
    id: "NEWS_RELEVANCE_MIN_SCORE",
    group: "enrichment",
    label: "News relevance minimum score",
    description:
      "Minimum 0-1 relevance score a headline must clear to count toward a symbol's news/sentiment.  Applies to provider-native scores (Alpha Vantage relevance_score, Marketaux match_score) and to this app's own headline-text rubric alike.",
    type: "number",
    defaultValue: 0.35,
    min: 0,
    max: 1
  }
] as const;

export function sourceSettingById(id: string): SourceSettingSpec | undefined {
  return SOURCE_SETTINGS_CATALOG.find((s) => s.id === id);
}

export function sourceSettingsByGroup(group: SourceSettingGroup): SourceSettingSpec[] {
  return SOURCE_SETTINGS_CATALOG.filter((s) => s.group === group);
}
