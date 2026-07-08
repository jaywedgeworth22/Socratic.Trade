// Per-provider request pacing for outbound market-data REST calls, plus a small helper
// to scrub API keys out of text before it is stored/logged (api_health_log rows are
// surfaced verbatim through connections-health / the ops snapshot, so an embedded key
// there is a real secret leak, not a cosmetic wart).
//
// Why a SEPARATE limiter from data-providers.ts's CONCURRENCY chunking: that chunking
// caps how many symbols a single provider processes in parallel per batch, but does
// nothing to pace the RATE of dispatch across batches/endpoints — e.g. Finnhub fires 5
// endpoints x 5 symbols = 25 near-simultaneous requests per chunk with zero inter-chunk
// delay. This module gates the actual outbound dispatch, independent of caller batching,
// so the cascade's chunking logic can stay untouched.

export interface ProviderLimiterClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: ProviderLimiterClock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
};

export interface ProviderLimiterConfig {
  /** Max requests in flight at once for this provider. Infinity = uncapped. */
  concurrency: number;
  /** Minimum spacing (ms) between successive dispatch starts. 0 = no pacing. */
  minIntervalMs: number;
}

// Hard defaults for providers with a real, known upstream limit. A provider with NO
// entry here (and no env override) resolves to `undefined` — fully unlimited, zero
// bookkeeping — so adding a new keyed provider never accidentally throttles it.
const HARD_DEFAULTS: Record<string, { perMin?: number; minIntervalMs?: number; concurrency?: number }> = {
  // Free tier is 60 req/min; 50 leaves headroom so the fetchWithRetry 429 backoff isn't
  // fighting the pacer too.
  finnhub: { perMin: 50 },
  // Free tier is ~1 req/sec (AND a 25/day cap the pacer can't do anything about) — strictly
  // serial with >1s spacing keeps every burst that trips the per-second gate from happening.
  "alpha-vantage": { minIntervalMs: 1100, concurrency: 1 },
  // No published limit, but the prod egress IP gets HTTP 429 on a cold burst while paced,
  // low-concurrency requests succeed — gentle pacing, not parallel bursts.
  "yahoo-finance": { minIntervalMs: 400, concurrency: 2 }
};

function envKeyFor(provider: string): string {
  return provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function finiteEnvNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Effective limiter config for a provider: env overrides win over hard defaults, and
 * `_MIN_INTERVAL_MS` wins over `_PER_MIN` when both env vars are set for the same
 * provider. Returns `undefined` when neither env nor a hard default applies — meaning
 * unlimited (callers must treat that as a passthrough, not a zero-wait limiter).
 */
export function resolveProviderLimiterConfig(provider: string): ProviderLimiterConfig | undefined {
  const hard = HARD_DEFAULTS[provider];
  const key = envKeyFor(provider);

  const envPerMin = finiteEnvNumber(`PROVIDER_RATE_LIMIT_${key}_PER_MIN`);
  const envMinInterval = finiteEnvNumber(`PROVIDER_RATE_LIMIT_${key}_MIN_INTERVAL_MS`);
  const envConcurrency = finiteEnvNumber(`PROVIDER_RATE_LIMIT_${key}_CONCURRENCY`);

  const minIntervalMs =
    envMinInterval !== undefined && envMinInterval >= 0
      ? envMinInterval
      : envPerMin !== undefined && envPerMin > 0
        ? Math.ceil(60_000 / envPerMin)
        : hard?.minIntervalMs ?? (hard?.perMin ? Math.ceil(60_000 / hard.perMin) : undefined);

  const concurrency = envConcurrency !== undefined && envConcurrency > 0 ? envConcurrency : hard?.concurrency;

  if (minIntervalMs === undefined && concurrency === undefined) return undefined;
  return { minIntervalMs: minIntervalMs ?? 0, concurrency: concurrency ?? Infinity };
}

interface LimiterState {
  config: ProviderLimiterConfig;
  inFlight: number;
  lastDispatchAt: number;
  queue: Array<() => void>;
  waking: boolean;
}

/**
 * A registry of per-provider pacers. Production code uses the module-level singleton
 * (`withProviderLimit`, real clock); tests construct their own instance with an
 * injected clock so pacing can be exercised without real wall-clock delays.
 */
export class ProviderRateLimiter {
  private readonly states = new Map<string, LimiterState>();

  constructor(private readonly clock: ProviderLimiterClock = realClock) {}

  /** Run `fn` gated by the named provider's limiter. A provider with no configured
   *  limit (see resolveProviderLimiterConfig) passes through immediately — no queueing,
   *  no bookkeeping. */
  async withLimit<T>(provider: string, fn: () => Promise<T>): Promise<T> {
    const config = resolveProviderLimiterConfig(provider);
    if (!config) return fn();

    const state = this.stateFor(provider, config);
    await this.acquire(state);
    try {
      return await fn();
    } finally {
      state.inFlight = Math.max(0, state.inFlight - 1);
      this.pump(state);
    }
  }

  /** Test-only escape hatch: drop bookkeeping for a provider (or every provider) so
   *  pacing state from one test can't bleed into the next. */
  reset(provider?: string): void {
    if (provider) this.states.delete(provider);
    else this.states.clear();
  }

  private stateFor(provider: string, config: ProviderLimiterConfig): LimiterState {
    let state = this.states.get(provider);
    if (!state) {
      state = { config, inFlight: 0, lastDispatchAt: -Infinity, queue: [], waking: false };
      this.states.set(provider, state);
    } else {
      // Env can change between calls (mainly a test concern) — always use the latest.
      state.config = config;
    }
    return state;
  }

  private acquire(state: LimiterState): Promise<void> {
    return new Promise((resolve) => {
      state.queue.push(resolve);
      this.pump(state);
    });
  }

  // Admits queued waiters as fast as concurrency + interval spacing allow, scheduling a
  // single wake-up (via the injected clock) when only the interval is blocking.
  private pump(state: LimiterState): void {
    while (state.queue.length > 0 && state.inFlight < state.config.concurrency) {
      const elapsed = this.clock.now() - state.lastDispatchAt;
      if (elapsed < state.config.minIntervalMs) {
        if (!state.waking) {
          state.waking = true;
          void this.clock.sleep(state.config.minIntervalMs - elapsed).then(() => {
            state.waking = false;
            this.pump(state);
          });
        }
        return;
      }
      const resolve = state.queue.shift();
      if (!resolve) break;
      state.inFlight += 1;
      state.lastDispatchAt = this.clock.now();
      resolve();
    }
  }
}

const defaultLimiter = new ProviderRateLimiter();

// Escape hatch for the production singleton only (mirrors API_CIRCUIT_BREAKER_DISABLED in
// api-circuit-breaker.ts) — tests exercising the full data-providers.ts call chain against
// real provider classes would otherwise inherit real-world pacing (real 400ms-1.2s waits
// per call) since they don't know about this module. A `ProviderRateLimiter` constructed
// directly (as in this module's own unit tests) is NOT affected — this only short-circuits
// the convenience wrapper below.
function providerRateLimitDisabled(): boolean {
  const v = (process.env.PROVIDER_RATE_LIMIT_DISABLED ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

/** Gate `fn` by the named provider's pacer (real clock, module-level singleton shared
 *  across every call site in the process). Providers with no configured limit pass
 *  through immediately, as does every call when PROVIDER_RATE_LIMIT_DISABLED is set. */
export async function withProviderLimit<T>(provider: string, fn: () => Promise<T>): Promise<T> {
  if (providerRateLimitDisabled()) return fn();
  return defaultLimiter.withLimit(provider, fn);
}

/** Test-only: clear the default limiter's pacing state. */
export function resetProviderRateLimiterState(provider?: string): void {
  defaultLimiter.reset(provider);
}

// ── Secret scrubbing ──────────────────────────────────────────────────────────────
// Provider error/warning text ends up stored verbatim in api_health_log and surfaced
// through connections-health / the ops snapshot. Some providers (Alpha Vantage in
// particular) embed the caller's own API key in that text — scrub it before it ever
// reaches logApiHealth.

const KEY_QUERY_PARAM_RE = /([?&](?:apikey|api_key|access_key|token)=)([^&\s"'<>]+)/gi;

/** Redact `apikey=<value>`-shaped query params (any casing of the common key names)
 *  embedded in arbitrary text — e.g. a URL that leaked into an error message. */
export function redactApiKeyParams(text: string): string {
  return text.replace(KEY_QUERY_PARAM_RE, "$1***");
}

/** Redact every literal occurrence of `secret` in `text`. No-op when secret is falsy. */
export function redactSecretValue(text: string, secret: string | undefined | null): string {
  if (!secret) return text;
  return text.split(secret).join("***");
}

/** Combined scrub: a known secret value (e.g. this provider's own API key) AND any
 *  `apikey=...`-shaped query param, so both "the key appeared verbatim" and "a URL
 *  containing the key leaked into the message" are covered. */
export function scrubProviderErrorText(text: string, secret?: string | null): string {
  return redactApiKeyParams(redactSecretValue(text, secret));
}

/** Append `err.cause` (when present) to an error message, truncated so one verbose
 *  network-layer cause can't blow out a health-log row. Otherwise "fetch failed"-class
 *  errors carry zero information about WHY. */
export function appendErrorCause(message: string, err: unknown, maxLen = 160): string {
  const cause = err instanceof Error ? (err as { cause?: unknown }).cause : undefined;
  if (cause === undefined || cause === null) return message;
  const causeText = String(cause).slice(0, maxLen);
  return `${message} (cause: ${causeText})`;
}
