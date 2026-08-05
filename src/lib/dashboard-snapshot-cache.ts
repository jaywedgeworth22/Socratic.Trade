/**
 * Short in-memory TTL + singleflight for getDashboardSnapshot (UX PR-C1).
 *
 * Cache key MUST include userId and account identity so multi-account users never
 * share snapshots. TTL is deliberately short (~10s) as a safety net when write-path
 * invalidation is incomplete; SSE/poll still refresh promptly after real changes.
 *
 * Kept in its own module (no db/dashboard imports) so policy writes and mobile
 * command completion can invalidate without circular deps.
 */

/** Default ~10s. Override via DASHBOARD_SNAPSHOT_TTL_MS (ms, clamped 1s–60s). */
export function dashboardSnapshotTtlMs(): number {
  const raw = Number(process.env.DASHBOARD_SNAPSHOT_TTL_MS ?? 10_000);
  if (!Number.isFinite(raw)) return 10_000;
  return Math.min(60_000, Math.max(1_000, raw));
}

/**
 * Canonical cache key: userId + accountNumber + connectedAccountId.
 * Empty-string slots are intentional so "no account" is a distinct key per user.
 */
export function dashboardSnapshotCacheKey(
  userId: string,
  accountNumber?: string | null,
  connectedAccountId?: string | null
): string {
  return `${userId}\0${accountNumber ?? ""}\0${connectedAccountId ?? ""}`;
}

type CacheEntry<T> = {
  expiresAt: number;
  value: T;
};

const cache = new Map<string, CacheEntry<unknown>>();
const inFlight = new Map<string, Promise<unknown>>();

/**
 * Drop cached snapshots. With no userId, clears the whole process cache (tests / ops).
 * With userId, drops every entry for that user across all accounts — policy writes and
 * command completion can change any account-scoped slice, so broad invalidation is safe
 * given the short TTL.
 */
export function invalidateDashboardSnapshotCache(userId?: string): void {
  if (!userId) {
    cache.clear();
    return;
  }
  for (const key of [...cache.keys()]) {
    if (key === userId || key.startsWith(`${userId}\0`)) cache.delete(key);
  }
}

/** Store (or overwrite) a cache entry under an additional key (e.g. post-build account identity). */
export function putDashboardSnapshotCache<T>(key: string, value: T): void {
  cache.set(key, { expiresAt: Date.now() + dashboardSnapshotTtlMs(), value });
}

/** Test helper: clear TTL entries and in-flight promises. */
export function resetDashboardSnapshotCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}

/** Test/observability: current entry count (excludes in-flight-only). */
export function dashboardSnapshotCacheSizeForTests(): number {
  return cache.size;
}

/**
 * Resolve a value through the short TTL cache with singleflight coalescing.
 * On hit, returns the cached value without invoking `factory`. Concurrent misses
 * for the same key share one in-flight promise.
 */
export async function withDashboardSnapshotCache<T>(
  key: string,
  factory: () => Promise<T>
): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key) as CacheEntry<T> | undefined;
  if (hit && hit.expiresAt > now) {
    return hit.value;
  }

  const pending = inFlight.get(key) as Promise<T> | undefined;
  if (pending) return pending;

  const promise = Promise.resolve()
    .then(factory)
    .then((value) => {
      cache.set(key, { expiresAt: Date.now() + dashboardSnapshotTtlMs(), value });
      return value;
    })
    .finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });

  inFlight.set(key, promise);
  return promise;
}
