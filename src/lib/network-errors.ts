/**
 * Shared classifiers for transport-layer failures.
 *
 * Two different things get labeled "the network died" in this codebase and they
 * must not be treated the same:
 *
 * - A **caller abort / budget timeout** (AbortController on `/api/quote`'s 6s
 *   cascade, nasdaq-calendar's 8s per-day fetch) is expected.  Log it soft so
 *   it cannot paint a lane STOPPED or mint a Sentry "connection failed".
 * - A **dead keep-alive socket** (`fetch failed` + `UND_ERR_SOCKET` /
 *   "other side closed") is transient and worth one retry.  It is still a
 *   hard health row if it survives the retry — a real outage must still page
 *   after the consecutive-failure streak.
 */

function errorText(error: unknown): string {
  const parts: unknown[] = [error];
  if (error && typeof error === "object" && "cause" in error) {
    parts.push((error as { cause: unknown }).cause);
  }
  return parts
    .map((part) => {
      if (!part) return "";
      if (part instanceof Error) {
        const code = (part as NodeJS.ErrnoException).code ?? "";
        return `${part.name} ${part.message} ${code}`;
      }
      if (typeof part === "object") {
        const rec = part as { code?: unknown; message?: unknown; name?: unknown };
        return `${rec.name ?? ""} ${rec.message ?? ""} ${rec.code ?? ""} ${String(part)}`;
      }
      return String(part);
    })
    .join(" ");
}

/** Caller cancelled the request (budget, teardown).  Do not retry. */
export function isAbortOrTimeoutError(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  if (name === "AbortError" || name === "TimeoutError") return true;
  return /this operation was aborted|the operation was aborted|\bAbortError\b|\bTimeoutError\b/i.test(
    errorText(error)
  );
}

/** Dead socket / DNS / reset — retry once, then count as a hard transport failure. */
export function isTransientNetworkError(error: unknown): boolean {
  if (isAbortOrTimeoutError(error)) return false;
  return /fetch failed|UND_ERR_SOCKET|other side closed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|\bEPIPE\b|ECONNABORTED|UND_ERR_CONNECT_TIMEOUT/i.test(
    errorText(error)
  );
}

export function isCallerSignalAborted(init: { signal?: AbortSignal | null } | undefined): boolean {
  return Boolean(init?.signal?.aborted);
}
