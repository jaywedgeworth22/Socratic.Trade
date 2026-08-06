// provider-tier-plan.ts — user-declared plan tiers for optional market-data keys.
//
// Connections/Settings lets the owner say "this Tiingo key is free vs Power" so the app can
// apply free-tier-safe quotas without requiring Infisical env knobs. Env
// PROVIDER_QUOTA_* / Usage Monitor knobs still win when set (see provider-rate-limit.ts).
//
// Facts live in docs/market-data-provider-pricing.md — keep labels/caps aligned when pricing
// changes. Mandatory infra (pinecone/voyage/openrouter/LLM) is intentionally out of this map.

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
    { id: "power", label: "Power", hint: "10k/hr · 100k/day · News API" },
    { id: "unknown", label: "Unknown", hint: "Use free-safe caps until you confirm" }
  ],
  massive: [
    { id: "free", label: "Free", hint: "5 calls/min · EOD · 2 yr history" },
    { id: "starter", label: "Stocks Starter", hint: "Unlimited REST · 15m delayed · 5 yr" },
    { id: "advanced", label: "Advanced", hint: "Real-time + ratios (higher plan)" },
    { id: "unknown", label: "Unknown" }
  ],
  // FMP is retired for ST product use — options remain for CT/admin archaeology only.
  fmp: [
    { id: "free", label: "Free", hint: "250/day" },
    { id: "starter", label: "Starter", hint: "~300/min · annual statements" },
    { id: "premium", label: "Premium", hint: "Quarterly fundamentals" },
    { id: "ultimate", label: "Ultimate", hint: "Transcripts (CT only)" },
    { id: "unknown", label: "Unknown" }
  ],
  twelvedata: [
    { id: "free", label: "Free / Basic", hint: "8 credits/min · 800/day" },
    { id: "grow", label: "Grow", hint: "377 credits/min · no daily cap" },
    { id: "pro", label: "Pro", hint: "WebSocket + higher credits" },
    { id: "unknown", label: "Unknown" }
  ],
  finnhub: [
    { id: "free", label: "Free", hint: "60 calls/min US-only — stay here" },
    { id: "all_in_one", label: "All-In-One", hint: "$3,500/mo — almost never justified" },
    { id: "unknown", label: "Unknown" }
  ],
  alphavantage: [
    { id: "free", label: "Free", hint: "25/day per IP (not per key)" },
    { id: "premium", label: "Premium", hint: "75/min · no daily cap" },
    { id: "unknown", label: "Unknown" }
  ],
  marketstack: [
    { id: "free", label: "Free", hint: "100 req/mo ≈ 3/day" },
    { id: "basic", label: "Basic", hint: "10,000 req/mo" },
    { id: "professional", label: "Professional", hint: "Higher volume + intraday" },
    { id: "business", label: "Business", hint: "Statements + long history" },
    { id: "unknown", label: "Unknown" }
  ],
  // Align with https://www.roic.ai/pricing — free is low request + short transcript history;
  // paid individual/professional unlock deep fundamentals + full transcript archive.
  roic: [
    { id: "free", label: "Free", hint: "~300 req/day · ~2 quarters transcripts" },
    { id: "starter", label: "Starter / Plus", hint: "Higher daily quota · longer transcript history" },
    { id: "individual", label: "Individual", hint: "Paid individual ~10k/day · full-text transcripts" },
    { id: "professional", label: "Professional", hint: "Highest request budget · all transcript history" },
    { id: "unknown", label: "Unknown", hint: "Use free-safe caps until you confirm" }
  ],
  filingapi: [
    { id: "free", label: "Free", hint: "~50 req/day (app uses 45)" },
    { id: "paid", label: "Paid", hint: "Higher daily cap (set when confirmed)" },
    { id: "unknown", label: "Unknown" }
  ],
  fintechstudios: [
    { id: "free", label: "Free", hint: "$0 marketing free plan" },
    { id: "pro", label: "Pro", hint: "Self-serve Pro credits" },
    { id: "unknown", label: "Unknown" }
  ],
  marketaux: [
    { id: "free", label: "Free", hint: "~100 req/day" },
    { id: "paid", label: "Paid", hint: "Higher daily budget" },
    { id: "unknown", label: "Unknown" }
  ],
  earningscalls: [
    { id: "preview", label: "Preview / trial", hint: "Limited preview entitlement" },
    { id: "paid", label: "Paid", hint: "Full transcript access" },
    { id: "unknown", label: "Unknown" }
  ],
  rapidapi: [
    { id: "basic", label: "Basic", hint: "Marketplace Basic / free-ish caps" },
    { id: "pro", label: "Pro", hint: "Higher RapidAPI plan" },
    { id: "unknown", label: "Unknown" }
  ]
};

/**
 * Quota windows implied by a declared tier when PROVIDER_QUOTA_* env / UM knobs are unset.
 * Missing entry → fall through to provider-rate-limit RATE_QUOTAS hard defaults.
 * Align with docs/market-data-provider-pricing.md upgrade cheat-sheet.
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
    unknown: [
      { maxRequests: 8, windowMs: MINUTE },
      { maxRequests: 800, windowMs: DAY }
    ]
  },
  fmp: {
    free: [{ maxRequests: 240, windowMs: DAY }],
    starter: [{ maxRequests: 290, windowMs: MINUTE }],
    premium: [{ maxRequests: 740, windowMs: MINUTE }],
    ultimate: [{ maxRequests: 2900, windowMs: MINUTE }],
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
    paid: [{ maxRequests: 500, windowMs: DAY }],
    unknown: [{ maxRequests: 45, windowMs: DAY }]
  },
  marketaux: {
    free: [{ maxRequests: 80, windowMs: DAY }],
    paid: [{ maxRequests: 1_000, windowMs: DAY }],
    unknown: [{ maxRequests: 80, windowMs: DAY }]
  },
  // Finnhub / Alpha Vantage / Massive mainly pace via HARD_DEFAULTS (per-min), not RATE_QUOTAS.
  // Still expose free-safe day caps for alphavantage so admit sites can use them later.
  alphavantage: {
    free: [{ maxRequests: 25, windowMs: DAY }],
    premium: [{ maxRequests: 75, windowMs: MINUTE }],
    unknown: [{ maxRequests: 25, windowMs: DAY }]
  },
  finnhub: {
    free: [{ maxRequests: 50, windowMs: MINUTE }],
    all_in_one: [{ maxRequests: 300, windowMs: MINUTE }],
    unknown: [{ maxRequests: 50, windowMs: MINUTE }]
  },
  massive: {
    free: [{ maxRequests: 5, windowMs: MINUTE }],
    // Unlimited REST on paid starter — empty array means "no windowed budget from tier"
    // (resolveProviderQuota treats empty tier base as unlimited unless RATE_QUOTAS/env add windows).
    starter: [],
    advanced: [],
    unknown: [{ maxRequests: 5, windowMs: MINUTE }]
  }
};

/** Normalize API key service / rate-limit provider names to TIER_OPTIONS keys. */
export function normalizePlanTierServiceId(service: string): string {
  const raw = service.trim().toLowerCase().replace(/[\s]+/g, "");
  if (raw === "alpha-vantage" || raw === "alpha_vantage") return "alphavantage";
  if (raw === "twelve-data" || raw === "twelve_data") return "twelvedata";
  if (raw === "fintech-studios" || raw === "fintech_studios" || raw === "powerintell") return "fintechstudios";
  if (raw === "filing-api" || raw === "filing_api") return "filingapi";
  if (raw === "earnings-calls" || raw === "earnings_calls") return "earningscalls";
  if (raw === "rapid-api" || raw === "rapid_api") return "rapidapi";
  return raw;
}

/** Services that show a plan-tier dropdown next to the key field. */
export function servicesWithPlanTierUi(): ReadonlySet<string> {
  return new Set(Object.keys(TIER_OPTIONS));
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
