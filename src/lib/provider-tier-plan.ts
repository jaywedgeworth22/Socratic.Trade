// provider-tier-plan.ts — user-declared plan tiers for optional market-data keys.
//
// Connections lets the owner say "this Tiingo key is free vs Power" so the app can
// apply free-tier-safe quotas without requiring Infisical env knobs. Env
// PROVIDER_QUOTA_* / Usage Monitor knobs still win when set (see provider-rate-limit.ts).
//
// Facts live in docs/market-data-provider-pricing.md — keep labels/caps aligned when pricing
// changes. LLM keys (openai/anthropic/openrouter/…) and pure contact strings (SEC User-Agent)
// stay out of this map: they are not multi-tier market-data quotas.
//
// Rule (owner 2026-08-06): every data source we use or have used (other than free-only
// infrastructure like SEC User-Agent) exposes a plan-tier dropdown with all common paid
// tiers a user might hold, plus free/unknown free-safe defaults.

export interface RateWindowHint {
  maxRequests: number;
  /** Rolling window length in ms. */
  windowMs: number;
}

export interface PlanTierOption {
  /** Stable id stored in user_api_keys.plan_tier */
  id: string;
  /** Dropdown label */
  label: string;
  /** Short description for title/tooltip */
  hint?: string;
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Canonical service ids match API_KEY_CATALOG / normalizeApiKeyService. */
const TIER_OPTIONS: Record<string, PlanTierOption[]> = {
  tiingo: [
    { id: "free", label: "Free", hint: "50/hr · 1,000/day · news not included" },
    { id: "power", label: "Power", hint: "10k/hr · 100k/day · News API · $30/mo or $300/yr" },
    { id: "commercial", label: "Commercial", hint: "Power-level + commercial license (~$499/yr site tier)" },
    { id: "unknown", label: "Unknown", hint: "Use free-safe caps until you confirm" }
  ],
  massive: [
    { id: "free", label: "Free", hint: "5 calls/min · EOD · 2 yr history" },
    { id: "starter", label: "Stocks Starter", hint: "$29/mo · Unlimited REST · 15m delayed · 5 yr" },
    { id: "developer", label: "Developer", hint: "Mid tier when offered · higher history/realtime than free" },
    { id: "advanced", label: "Advanced", hint: "~$199/mo · Real-time + trades/quotes + ratios" },
    { id: "business", label: "Business / Enterprise", hint: "Highest Massive plan · contact sales shape" },
    { id: "unknown", label: "Unknown" }
  ],
  // FMP retired for ST product use — options remain for CT/admin archaeology + accurate quotas.
  fmp: [
    { id: "free", label: "Free", hint: "250/day · EOD" },
    { id: "starter", label: "Starter", hint: "~300/min · annual statements · $22/mo annual" },
    { id: "premium", label: "Premium", hint: "~750/min · quarterly fundamentals" },
    { id: "ultimate", label: "Ultimate", hint: "~3k/min · transcripts (CT only on ST)" },
    { id: "unknown", label: "Unknown" }
  ],
  twelvedata: [
    { id: "free", label: "Free / Basic", hint: "8 credits/min · 800/day" },
    { id: "grow", label: "Grow", hint: "377 credits/min · no daily cap · ~$79/mo" },
    { id: "pro", label: "Pro", hint: "WebSocket + higher credits · ~$229/mo" },
    { id: "ultra", label: "Ultra / Enterprise", hint: "Highest credit budget" },
    { id: "unknown", label: "Unknown" }
  ],
  finnhub: [
    { id: "free", label: "Free", hint: "60 calls/min US-only — stay here" },
    { id: "all_in_one", label: "All-In-One", hint: "$3,500/mo — almost never justified" },
    { id: "unknown", label: "Unknown" }
  ],
  alphavantage: [
    { id: "free", label: "Free", hint: "25/day per IP (not per key)" },
    { id: "premium_49", label: "Premium $50", hint: "75/min · no daily cap · entry paid" },
    { id: "premium", label: "Premium (any)", hint: "75+/min paid plan" },
    { id: "premium_149", label: "Premium higher", hint: "Higher AV paid steps if purchased" },
    { id: "unknown", label: "Unknown" }
  ],
  marketstack: [
    { id: "free", label: "Free", hint: "100 req/mo ≈ 3/day" },
    { id: "basic", label: "Basic", hint: "10,000 req/mo ≈ 333/day · $9.99/mo" },
    { id: "professional", label: "Professional", hint: "Higher volume + sub-15m · ~$50/mo" },
    { id: "business", label: "Business", hint: "Statements + long history · ~$150/mo" },
    { id: "unknown", label: "Unknown" }
  ],
  roic: [
    { id: "free", label: "Free", hint: "~300 req/day · ~2 quarters transcripts" },
    { id: "starter", label: "Starter / Plus", hint: "Higher daily quota · longer transcript history" },
    { id: "individual", label: "Individual", hint: "Paid individual ~10k/day · full-text transcripts" },
    { id: "professional", label: "Professional", hint: "Highest request budget · all transcript history" },
    { id: "unknown", label: "Unknown", hint: "Use free-safe caps until you confirm" }
  ],
  filingapi: [
    { id: "free", label: "Free", hint: "~50 req/day (app uses 45)" },
    { id: "starter", label: "Starter", hint: "Entry paid when offered" },
    { id: "pro", label: "Pro", hint: "Higher daily cap" },
    { id: "paid", label: "Paid (generic)", hint: "Any paid plan — 500/day placeholder" },
    { id: "unknown", label: "Unknown" }
  ],
  fintechstudios: [
    { id: "free", label: "Free", hint: "$0 marketing free plan" },
    { id: "pro", label: "Pro", hint: "Self-serve Pro credits (~$20–120/mo)" },
    { id: "enterprise", label: "Enterprise", hint: "Contact-sales institutional feed" },
    { id: "unknown", label: "Unknown" }
  ],
  marketaux: [
    { id: "free", label: "Free", hint: "~100 req/day" },
    { id: "starter", label: "Starter", hint: "Entry paid news budget" },
    { id: "professional", label: "Professional", hint: "Higher news volume" },
    { id: "paid", label: "Paid (generic)", hint: "Any paid plan — 1k/day placeholder" },
    { id: "unknown", label: "Unknown" }
  ],
  earningscalls: [
    { id: "preview", label: "Preview / free", hint: "Short previews · limited monthly requests" },
    { id: "basic", label: "Basic", hint: "Entry paid full-text when offered" },
    { id: "pro", label: "Pro", hint: "Higher full-text quota" },
    { id: "paid", label: "Paid (generic)", hint: "Full transcript access" },
    { id: "unknown", label: "Unknown" }
  ],
  rapidapi: [
    { id: "basic", label: "Basic / Free hub", hint: "≤~1k req/hr platform ceiling · per-API free quotas" },
    { id: "pro", label: "Pro", hint: "Higher marketplace plan" },
    { id: "ultra", label: "Ultra", hint: "Highest RapidAPI personal plan" },
    { id: "mega", label: "Mega / Enterprise", hint: "Org marketplace plan" },
    { id: "unknown", label: "Unknown" }
  ],
  // Free-only economic data — still show free/unknown so UI is consistent.
  fred: [
    { id: "free", label: "Free", hint: "No paid tiers — FRED is always free with a key" },
    { id: "unknown", label: "Unknown" }
  ],
  apify: [
    { id: "free", label: "Free", hint: "Limited compute units / month" },
    { id: "starter", label: "Starter", hint: "Entry paid Actor compute" },
    { id: "scale", label: "Scale", hint: "Higher compute + concurrency" },
    { id: "business", label: "Business", hint: "Team / production scrapers" },
    { id: "enterprise", label: "Enterprise", hint: "Highest plan" },
    { id: "unknown", label: "Unknown" }
  ],
  logodev: [
    { id: "free", label: "Community free", hint: "500k req/mo · attribution may apply" },
    { id: "startup", label: "Startup", hint: "~1M req/mo · no attribution · annual" },
    { id: "pro", label: "Pro", hint: "Brand API + higher volume" },
    { id: "unknown", label: "Unknown" }
  ],
  // Broker market-data sides (if ever stored as keys) — Tradier is account-linked today.
  tradier: [
    { id: "sandbox", label: "Sandbox", hint: "15m delayed · 60/min market-data typical" },
    { id: "live_lite", label: "Live Lite $0", hint: "Production token · real-time on funded/live account" },
    { id: "live", label: "Live (any plan)", hint: "Production market-data rates · ~120/min typical" },
    { id: "unknown", label: "Unknown" }
  ],
  // RAG infra (if added to Connections catalog later — safe to expose tiers).
  pinecone: [
    { id: "free", label: "Free / Starter", hint: "Serverless free allowance · low WU" },
    { id: "standard", label: "Standard", hint: "Paid serverless" },
    { id: "enterprise", label: "Enterprise", hint: "Highest capacity" },
    { id: "unknown", label: "Unknown" }
  ],
  voyage: [
    { id: "free", label: "Free", hint: "Low free embed tokens" },
    { id: "paid", label: "Paid", hint: "Metered embeddings" },
    { id: "unknown", label: "Unknown" }
  ],
  siliconflow: [
    { id: "free", label: "Free", hint: "Low free embed/chat allowance" },
    { id: "paid", label: "Paid", hint: "Metered" },
    { id: "unknown", label: "Unknown" }
  ]
};

/**
 * Quota windows implied by a declared tier when PROVIDER_QUOTA_* env / UM knobs are unset.
 * Missing entry → fall through to provider-rate-limit RATE_QUOTAS hard defaults.
 * Empty array = intentionally unlimited windowed budget (e.g. Massive starter REST).
 * Align with docs/market-data-provider-pricing.md.
 */
const TIER_QUOTA_WINDOWS: Record<string, Record<string, RateWindowHint[]>> = {
  tiingo: {
    free: [
      { maxRequests: 50, windowMs: HOUR },
      { maxRequests: 1000, windowMs: DAY }
    ],
    power: [
      { maxRequests: 10_000, windowMs: HOUR },
      { maxRequests: 100_000, windowMs: DAY }
    ],
    commercial: [
      { maxRequests: 10_000, windowMs: HOUR },
      { maxRequests: 100_000, windowMs: DAY }
    ],
    unknown: [
      { maxRequests: 50, windowMs: HOUR },
      { maxRequests: 1000, windowMs: DAY }
    ]
  },
  twelvedata: {
    free: [
      { maxRequests: 8, windowMs: MINUTE },
      { maxRequests: 800, windowMs: DAY }
    ],
    grow: [{ maxRequests: 377, windowMs: MINUTE }],
    pro: [{ maxRequests: 800, windowMs: MINUTE }],
    ultra: [{ maxRequests: 1_500, windowMs: MINUTE }],
    unknown: [
      { maxRequests: 8, windowMs: MINUTE },
      { maxRequests: 800, windowMs: DAY }
    ]
  },
  fmp: {
    free: [{ maxRequests: 240, windowMs: DAY }],
    starter: [{ maxRequests: 290, windowMs: MINUTE }],
    premium: [{ maxRequests: 740, windowMs: MINUTE }],
    ultimate: [{ maxRequests: 2_900, windowMs: MINUTE }],
    unknown: [{ maxRequests: 240, windowMs: DAY }]
  },
  marketstack: {
    free: [{ maxRequests: 3, windowMs: DAY }],
    basic: [{ maxRequests: 333, windowMs: DAY }],
    professional: [{ maxRequests: 1_000, windowMs: DAY }],
    business: [{ maxRequests: 3_000, windowMs: DAY }],
    unknown: [{ maxRequests: 3, windowMs: DAY }]
  },
  roic: {
    free: [{ maxRequests: 300, windowMs: DAY }],
    starter: [{ maxRequests: 2_000, windowMs: DAY }],
    individual: [{ maxRequests: 10_000, windowMs: DAY }],
    professional: [{ maxRequests: 50_000, windowMs: DAY }],
    unknown: [{ maxRequests: 300, windowMs: DAY }]
  },
  filingapi: {
    free: [{ maxRequests: 45, windowMs: DAY }],
    starter: [{ maxRequests: 200, windowMs: DAY }],
    pro: [{ maxRequests: 1_000, windowMs: DAY }],
    paid: [{ maxRequests: 500, windowMs: DAY }],
    unknown: [{ maxRequests: 45, windowMs: DAY }]
  },
  marketaux: {
    free: [{ maxRequests: 80, windowMs: DAY }],
    starter: [{ maxRequests: 500, windowMs: DAY }],
    professional: [{ maxRequests: 2_000, windowMs: DAY }],
    paid: [{ maxRequests: 1_000, windowMs: DAY }],
    unknown: [{ maxRequests: 80, windowMs: DAY }]
  },
  alphavantage: {
    free: [{ maxRequests: 25, windowMs: DAY }],
    premium_49: [{ maxRequests: 75, windowMs: MINUTE }],
    premium: [{ maxRequests: 75, windowMs: MINUTE }],
    premium_149: [{ maxRequests: 150, windowMs: MINUTE }],
    unknown: [{ maxRequests: 25, windowMs: DAY }]
  },
  finnhub: {
    free: [{ maxRequests: 50, windowMs: MINUTE }],
    all_in_one: [{ maxRequests: 300, windowMs: MINUTE }],
    unknown: [{ maxRequests: 50, windowMs: MINUTE }]
  },
  massive: {
    free: [{ maxRequests: 5, windowMs: MINUTE }],
    starter: [],
    developer: [],
    advanced: [],
    business: [],
    unknown: [{ maxRequests: 5, windowMs: MINUTE }]
  },
  fintechstudios: {
    free: [{ maxRequests: 50, windowMs: DAY }],
    pro: [{ maxRequests: 500, windowMs: DAY }],
    enterprise: [{ maxRequests: 5_000, windowMs: DAY }],
    unknown: [{ maxRequests: 50, windowMs: DAY }]
  },
  earningscalls: {
    // Soft request budgets (provider hard caps vary); dual-bound ledger also enforces monthly.
    preview: [{ maxRequests: 8, windowMs: DAY }],
    basic: [{ maxRequests: 50, windowMs: DAY }],
    pro: [{ maxRequests: 200, windowMs: DAY }],
    paid: [{ maxRequests: 100, windowMs: DAY }],
    unknown: [{ maxRequests: 8, windowMs: DAY }]
  },
  rapidapi: {
    // Platform free ceiling ~1000/hr; per-API free quotas are usually much lower — stay conservative.
    basic: [
      { maxRequests: 60, windowMs: MINUTE },
      { maxRequests: 500, windowMs: DAY }
    ],
    pro: [
      { maxRequests: 300, windowMs: MINUTE },
      { maxRequests: 5_000, windowMs: DAY }
    ],
    ultra: [
      { maxRequests: 600, windowMs: MINUTE },
      { maxRequests: 20_000, windowMs: DAY }
    ],
    mega: [
      { maxRequests: 1_000, windowMs: MINUTE },
      { maxRequests: 50_000, windowMs: DAY }
    ],
    unknown: [
      { maxRequests: 30, windowMs: MINUTE },
      { maxRequests: 200, windowMs: DAY }
    ]
  },
  fred: {
    free: [{ maxRequests: 100, windowMs: MINUTE }],
    unknown: [{ maxRequests: 100, windowMs: MINUTE }]
  },
  apify: {
    free: [{ maxRequests: 50, windowMs: DAY }],
    starter: [{ maxRequests: 500, windowMs: DAY }],
    scale: [{ maxRequests: 2_000, windowMs: DAY }],
    business: [{ maxRequests: 10_000, windowMs: DAY }],
    enterprise: [{ maxRequests: 50_000, windowMs: DAY }],
    unknown: [{ maxRequests: 50, windowMs: DAY }]
  },
  logodev: {
    // Soft daily approximation of monthly free 500k (~16k/day).
    free: [{ maxRequests: 10_000, windowMs: DAY }],
    startup: [{ maxRequests: 30_000, windowMs: DAY }],
    pro: [{ maxRequests: 100_000, windowMs: DAY }],
    unknown: [{ maxRequests: 5_000, windowMs: DAY }]
  },
  tradier: {
    sandbox: [{ maxRequests: 50, windowMs: MINUTE }],
    live_lite: [{ maxRequests: 100, windowMs: MINUTE }],
    live: [{ maxRequests: 120, windowMs: MINUTE }],
    unknown: [{ maxRequests: 50, windowMs: MINUTE }]
  },
  pinecone: {
    free: [{ maxRequests: 100, windowMs: MINUTE }],
    standard: [{ maxRequests: 500, windowMs: MINUTE }],
    enterprise: [{ maxRequests: 2_000, windowMs: MINUTE }],
    unknown: [{ maxRequests: 100, windowMs: MINUTE }]
  },
  voyage: {
    free: [{ maxRequests: 3, windowMs: MINUTE }],
    paid: [{ maxRequests: 60, windowMs: MINUTE }],
    unknown: [{ maxRequests: 3, windowMs: MINUTE }]
  },
  siliconflow: {
    free: [{ maxRequests: 10, windowMs: MINUTE }],
    paid: [{ maxRequests: 120, windowMs: MINUTE }],
    unknown: [{ maxRequests: 10, windowMs: MINUTE }]
  }
};

/**
 * Market-data / data-platform services that MUST show a plan-tier dropdown on Connections.
 * Mirrors API_KEY_CATALOG non-LLM data rows + brokers/RAG we may store keys for.
 * SEC User-Agent is intentionally excluded (contact string, not a tiered API plan).
 */
export const PLAN_TIER_REQUIRED_SERVICES: readonly string[] = [
  "tiingo",
  "massive",
  "fmp",
  "twelvedata",
  "finnhub",
  "alphavantage",
  "marketstack",
  "roic",
  "filingapi",
  "fintechstudios",
  "marketaux",
  "earningscalls",
  "rapidapi",
  "fred",
  "apify",
  "logodev",
  "tradier",
  "pinecone",
  "voyage",
  "siliconflow"
] as const;

/** Normalize API key service / rate-limit provider names to TIER_OPTIONS keys. */
export function normalizePlanTierServiceId(service: string): string {
  const raw = service.trim().toLowerCase().replace(/[\s]+/g, "");
  if (raw === "alpha-vantage" || raw === "alpha_vantage") return "alphavantage";
  if (raw === "twelve-data" || raw === "twelve_data") return "twelvedata";
  if (raw === "fintech-studios" || raw === "fintech_studios" || raw === "powerintell") return "fintechstudios";
  if (raw === "filing-api" || raw === "filing_api") return "filingapi";
  if (raw === "earnings-calls" || raw === "earnings_calls" || raw === "earningscallsdev") return "earningscalls";
  if (raw === "rapid-api" || raw === "rapid_api") return "rapidapi";
  if (raw === "logo_dev" || raw === "logo-dev") return "logodev";
  if (raw === "polygon" || raw === "polygon_io") return "massive";
  return raw;
}

/** Services that show a plan-tier dropdown next to the key field. */
export function servicesWithPlanTierUi(): ReadonlySet<string> {
  return new Set([...Object.keys(TIER_OPTIONS), ...PLAN_TIER_REQUIRED_SERVICES]);
}

export function planTierOptionsForService(service: string): PlanTierOption[] | null {
  const canonical = normalizePlanTierServiceId(service);
  const opts = TIER_OPTIONS[canonical];
  return opts ? opts.map((o) => ({ ...o })) : null;
}

export function isValidPlanTierForService(service: string, tier: string): boolean {
  const opts = planTierOptionsForService(service);
  if (!opts) return false;
  return opts.some((o) => o.id === tier);
}

/** Default when a key exists but no tier was ever chosen — free-safe. */
export function defaultPlanTierForService(service: string): string {
  const opts = planTierOptionsForService(service);
  if (!opts || opts.length === 0) return "unknown";
  if (opts.some((o) => o.id === "free")) return "free";
  if (opts.some((o) => o.id === "basic")) return "basic";
  if (opts.some((o) => o.id === "preview")) return "preview";
  if (opts.some((o) => o.id === "sandbox")) return "sandbox";
  return opts[0]!.id;
}

/**
 * Quota windows for a declared tier. Returns:
 *  - undefined when the service has no tier map or tier id is unknown to the map
 *    (caller should use RATE_QUOTAS hard defaults)
 *  - empty array when the tier is intentionally unlimited (e.g. Massive starter)
 *  - non-empty windows otherwise
 */
export function quotaWindowsForPlan(service: string, tier: string): RateWindowHint[] | undefined {
  const canonical = normalizePlanTierServiceId(service);
  const byTier = TIER_QUOTA_WINDOWS[canonical];
  if (!byTier) return undefined;
  const windows = byTier[tier];
  if (windows === undefined) return undefined;
  return windows.map((w) => ({ ...w }));
}

/** Provider names used by RATE_QUOTAS / admitProviderRequests (hyphen form for some). */
export function rateLimitProviderName(service: string): string {
  const canonical = normalizePlanTierServiceId(service);
  if (canonical === "alphavantage") return "alpha-vantage";
  return canonical;
}

/** Map rate-limit provider ids back to API key service ids. */
export function apiKeyServiceForRateLimitProvider(provider: string): string {
  if (provider === "alpha-vantage") return "alphavantage";
  return provider;
}

/**
 * How many completed fiscal quarters of earnings transcripts a declared ROIC plan should
 * attempt per symbol (scheduler + refresh). Free is intentionally shallow; paid goes deep.
 */
export function roicTranscriptQuartersForPlan(tier: string | null | undefined): number {
  switch ((tier ?? "unknown").toLowerCase()) {
    case "professional":
      return 8;
    case "individual":
      return 6;
    case "starter":
    case "plus":
      return 4;
    case "free":
    case "unknown":
    default:
      return 2;
  }
}

/** True when ST product must not use this service (key row may still be visible). */
export function isRetiredMarketDataService(service: string): boolean {
  const id = normalizePlanTierServiceId(service);
  // Keep in sync with retired-direct-vendors + Connections health intentional OFF.
  return id === "fmp" || id === "quiverquant" || id === "quiver" || id === "unusual_whales";
}

/**
 * Services that must never show a plan-tier dropdown (LLM keys, contact strings).
 * Used by tests to lock the catalog policy.
 */
export function isNonPlanTierService(service: string): boolean {
  const id = normalizePlanTierServiceId(service);
  if (id === "sec_edgar_user_agent" || id === "sec_edgar") return true;
  const llm = new Set([
    "openai",
    "anthropic",
    "xai",
    "gemini",
    "mistral",
    "deepseek",
    "moonshot",
    "kimi",
    "openrouter",
    "meta"
  ]);
  return llm.has(id);
}

// ── Process-wide plan-tier lookup (operator / local key store) ───────────────
// Registered by db-api-keys after getUserApiKey is defined. provider-rate-limit
// consults this when resolveProviderQuota is called without an explicit planTier.
// Lives here (not in db-api-keys) so the rate-limit module never needs to import
// the DB layer.

type PlanTierLookup = (service: string) => string | null | undefined;

let planTierLookup: PlanTierLookup | undefined;

/** Wire the DB-backed lookup (called once from db-api-keys at module init). */
export function registerPlanTierLookup(fn: PlanTierLookup): void {
  planTierLookup = fn;
}

/** Test helper: clear or replace the lookup. */
export function registerPlanTierLookupForTests(fn: PlanTierLookup | undefined): void {
  planTierLookup = fn;
}

/**
 * Effective stored plan tier for a rate-limit provider name (e.g. "tiingo", "alpha-vantage").
 * Returns undefined when no lookup is registered; null when registered but no row/tier.
 */
export function lookupRegisteredPlanTier(provider: string): string | null | undefined {
  if (!planTierLookup) return undefined;
  const service = apiKeyServiceForRateLimitProvider(provider);
  return planTierLookup(service);
}
