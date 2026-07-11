import { rateLimit, type RateLimitOptions } from "./rate-limit";
import { resolveRequestUserId } from "./request-user";
import { withTuningSingleFlight } from "./tuning-singleflight";
import { operationInFlightResponse, rateLimitedOperationResponse } from "./operation-guard-response";
import { withInFlightGuard, resetOperationsInFlight } from "./in-flight";

type ConcurrencyScope = "admin" | "manual-admin";

interface StandardAdminOperationLimit extends RateLimitOptions {
  /** Operations sharing a group cannot overlap within the configured scope. */
  concurrencyGroup: string;
  /** Across manual admin requests for shared work; per admin for user-scoped analysis or probes. */
  concurrencyScope: ConcurrencyScope;
}

interface SharedTuningOperationLimit extends RateLimitOptions {
  sharedSingleFlight: "tuning";
}

type AdminOperationLimit = StandardAdminOperationLimit | SharedTuningOperationLimit;

/**
 * Interactive-admin budgets: generous enough for normal retries, tight enough that a stuck UI,
 * script, or duplicate click cannot repeatedly fan out into paid providers or long DB scans.
 * Rate limits are per authenticated admin even when the in-flight exclusion is global.
 */
export const ADMIN_OPERATION_LIMITS = {
  "reindex-8k": { limit: 2, windowMs: 60 * 60_000, concurrencyGroup: "rag-reindex", concurrencyScope: "manual-admin" },
  "reindex-10k": { limit: 2, windowMs: 60 * 60_000, concurrencyGroup: "rag-reindex", concurrencyScope: "manual-admin" },
  "backtest-ic": { limit: 10, windowMs: 5 * 60_000, concurrencyGroup: "backtest-ic", concurrencyScope: "admin" },
  "tuning-dry-run": { limit: 6, windowMs: 10 * 60_000, sharedSingleFlight: "tuning" },
  "congress-score-eval": { limit: 6, windowMs: 10 * 60_000, concurrencyGroup: "congress-score-eval", concurrencyScope: "admin" },
  "congress-share": { limit: 2, windowMs: 60 * 60_000, concurrencyGroup: "congress-share", concurrencyScope: "manual-admin" },
  "refresh-websource": { limit: 4, windowMs: 10 * 60_000, concurrencyGroup: "refresh-websource", concurrencyScope: "manual-admin" },
  "robinhood-probe": { limit: 20, windowMs: 5 * 60_000, concurrencyGroup: "robinhood-probe", concurrencyScope: "admin" }
} as const satisfies Record<string, AdminOperationLimit>;

export type AdminOperationName = keyof typeof ADMIN_OPERATION_LIMITS;

/**
 * Only call this after `requireAdmin` succeeds. `resolveRequestUserId` consumes the trusted
 * middleware-established email header and ignores query/body/user-id hints. Token-only and local-dev
 * admin calls intentionally collapse to the stable primary-operator `local` identity.
 */
export function adminOperationIdentity(request: Request): string {
  return resolveRequestUserId(request);
}

function concurrencyKey(identity: string, operation: AdminOperationName): string {
  const config = ADMIN_OPERATION_LIMITS[operation];
  if (!("concurrencyGroup" in config)) throw new Error(`Admin operation ${operation} uses a shared single-flight guard.`);
  const scope = config.concurrencyScope === "manual-admin" ? "manual-admin" : `admin:${identity}`;
  return `${scope}:${config.concurrencyGroup}`;
}

/**
 * Apply the named per-admin budget and a process-wide single-flight guard around expensive work.
 * The in-flight entry is always released, including when the operation throws.
 */
export async function withAdminOperationGuard(
  request: Request,
  operation: AdminOperationName,
  run: () => Promise<Response>
): Promise<Response> {
  const identity = adminOperationIdentity(request);
  const config = ADMIN_OPERATION_LIMITS[operation];

  if ("sharedSingleFlight" in config) {
    return withTuningSingleFlight(identity, "tuning-dry-run", async () => {
      const admission = rateLimit(`${identity}:admin:${operation}`, config);
      if (!admission.allowed) {
        return rateLimitedOperationResponse(
          operation,
          admission.retryAfterSeconds,
          `Rate limit exceeded for admin operation "${operation}". Please retry shortly.`
        );
      }
      return run();
    });
  }

  const flightKey = concurrencyKey(identity, operation);
  
  // For operations that manage their own underlying system-wide locks (web sources, congress share, rag reindex), 
  // we do NOT acquire an admin-level lock. This allows their internal lock to protect against both manual and scheduler runs.
  const selfGuardedOps = ["reindex-8k", "reindex-10k", "congress-share", "refresh-websource"];
  const isSelfGuarded = selfGuardedOps.includes(operation);

  const runWithRateLimit = async () => {
    const admission = rateLimit(`${identity}:admin:${operation}`, config);
    if (!admission.allowed) {
      return rateLimitedOperationResponse(
        operation,
        admission.retryAfterSeconds,
        `Rate limit exceeded for admin operation "${operation}". Please retry shortly.`
      );
    }
    return await run();
  };

  if (isSelfGuarded) {
    return runWithRateLimit();
  }

  const result = await withInFlightGuard(flightKey, runWithRateLimit);
  if (result && typeof result === "object" && "inFlightConflict" in result && result.inFlightConflict) {
    return operationInFlightResponse(
      operation,
      operation,
      `Admin operation "${operation}" conflicts with "${result.activeOperation}", which is already running.`
    );
  }
  return result as Response;
}

/** Test/maintenance hook; does not reset the shared rate limiter. */
export function resetAdminOperationInFlight(): void {
  resetOperationsInFlight();
}
