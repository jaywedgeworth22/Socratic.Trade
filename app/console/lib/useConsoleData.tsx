"use client";

/** The console's single data layer: one polled GET /api/dashboard snapshot
 *  shared by every screen via context, refreshed on an interval, after every
 *  mutation, and when the tab becomes visible again. Errors never blank the
 *  screen — the last good snapshot stays up and a visible staleness notice is
 *  derived from `error` + `fetchedAt`. */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import type { DashboardSnapshot } from "../../dashboard-types";
import { ConsoleApiError, fetchDashboard } from "./api";

const POLL_MS = 15_000;
const EVENT_REFRESH_DEBOUNCE_MS = 200;
// If the very first snapshot hasn't arrived by the time this fires, the shell would otherwise sit
// on the logo forever (a hung upstream fetch with no client-side deadline). Flip to the existing
// error card instead — it already auto-retries via the poll interval above.
const FIRST_LOAD_WATCHDOG_MS = 15_000;
const FIRST_LOAD_WATCHDOG_MESSAGE = "The dashboard is taking too long to respond. Retrying…";
// Hard per-attempt ceiling, independent of anything the server does. fetchDashboard has no
// built-in timeout, so a request that hangs at the network layer (an open connection that never
// receives data — exactly the kernel TCP-memory-exhaustion failure mode that caused the prod
// incident this file's coalescing logic exists to fix) would otherwise sit in `inFlight` forever:
// every later SSE/poll/visibility trigger only sets `pendingBackgroundRefresh` and returns (by
// design, to avoid resurrecting the old abort-storm), so nothing would ever start a fresh attempt.
// This timer fires ONCE per attempt (not once per event), so it cannot reintroduce that storm — it
// only kills an attempt that has been stuck well past what any real (even fully degraded) response
// should take.
//
// This ceiling MUST sit above the server's own worst-case self-bounded response. getDashboardSnapshot
// races each upstream against its own deadline, but the broker chain is SEQUENTIAL — gateway.getAccounts
// (6s) → portfolio/positions/orders (8s) → getEquityQuotes (6s) = 20s — and computeSpyBenchmark (4s) runs
// after it, so a slow-but-not-hung account with held symbols can legitimately take ~24s to return a fully
// degraded snapshot. A client ceiling at/below that would abort right as the server is about to respond,
// retry, and keep the console stuck on the watchdog/retry path even though the server deadlines are
// working as designed. 35s leaves headroom over that 24s server bound (plus sync DB work) while still
// killing a genuine network hang, which never resolves at all.
const FETCH_DEADLINE_MS = 35_000;
// Sentinel abort reason so a deadline-triggered abort can be told apart from an explicit refresh()
// superseding this attempt (which aborts with no reason / the default AbortError).
const DEADLINE_REASON = Symbol("dashboard-fetch-deadline");
// Shown while a deadline-aborted attempt is retrying. Setting `error` here is what makes the
// freshness strip flip to "delayed" — without it, a request that keeps hanging past
// FETCH_DEADLINE_MS would retry every ~35s forever with `error` still null, so the console would
// keep labeling an old snapshot "fresh" even though no refresh has actually landed.
const DEADLINE_ERROR_MESSAGE = "The dashboard is taking too long to respond. Retrying…";

export type ConsoleStreamStatus = "unsupported" | "connecting" | "live" | "reconnecting";

export interface ConsoleStreamHealth {
  status: ConsoleStreamStatus;
  connectedAt: Date | null;
  lastEventAt: Date | null;
  lastEventType: string | null;
  lastErrorAt: Date | null;
}

export interface ConsoleData {
  snapshot: DashboardSnapshot | null;
  /** When the current snapshot was fetched (client clock). */
  fetchedAt: Date | null;
  /** True only before the very first snapshot arrives. */
  loading: boolean;
  /** Last fetch error (the previous snapshot stays rendered). */
  error: string | null;
  /** Health of the SSE stream used for push refreshes. */
  stream: ConsoleStreamHealth;
  /** Force a refetch now (used after every mutation). */
  refresh: () => Promise<void>;
}

const ConsoleDataContext = createContext<ConsoleData | null>(null);

const UNSUPPORTED_STREAM: ConsoleStreamHealth = {
  status: "unsupported",
  connectedAt: null,
  lastEventAt: null,
  lastEventType: null,
  lastErrorAt: null
};

export function ConsoleDataProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState<ConsoleStreamHealth>(UNSUPPORTED_STREAM);
  const inFlight = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const queuedRefresh = useRef<number | null>(null);
  // Set when a background trigger (SSE event, poll interval, tab becoming visible) arrives while a
  // fetch is already in flight. Consumed once that fetch settles, to run exactly one more
  // (coalesced) fetch instead of a fresh abort-and-refetch per trigger — see backgroundRefresh below.
  const pendingBackgroundRefresh = useRef(false);

  // Returns "deadline" when THIS attempt was killed by our own FETCH_DEADLINE_MS timer (distinct
  // from "aborted", which means something else — an explicit refresh() — superseded it). Callers
  // use that distinction to decide whether to retry immediately.
  const runFetch = useCallback(async (controller: AbortController): Promise<"ok" | "deadline" | "aborted" | "error"> => {
    const deadline = window.setTimeout(() => controller.abort(DEADLINE_REASON), FETCH_DEADLINE_MS);
    try {
      const data = await fetchDashboard<DashboardSnapshot>(controller.signal);
      if (!mounted.current || controller.signal.aborted) return "aborted";
      setSnapshot(data);
      setFetchedAt(new Date());
      setError(null);
      return "ok";
    } catch (err) {
      if (controller.signal.aborted) {
        if (controller.signal.reason !== DEADLINE_REASON) return "aborted";
        // Surface the hung attempt as a refresh error before runLoop retries, so the freshness UI
        // stops calling a stale snapshot "fresh". A successful retry clears this via setError(null).
        if (mounted.current) setError((prev) => prev ?? DEADLINE_ERROR_MESSAGE);
        return "deadline";
      }
      if (err instanceof DOMException && err.name === "AbortError") return "aborted";
      if (!mounted.current) return "error";
      setError(err instanceof ConsoleApiError ? err.message : "Could not refresh data.");
      return "error";
    } finally {
      window.clearTimeout(deadline);
    }
  }, []);

  // Shared retry loop used by BOTH refresh() and backgroundRefresh() (the caller is responsible for
  // aborting whatever was previously in flight, and for the "already in flight → just mark pending"
  // short-circuit — see below). Each iteration runs one attempt with a fresh AbortController and
  // then decides whether to run another:
  //  - "deadline": THIS attempt hung past FETCH_DEADLINE_MS and was self-aborted — retry immediately
  //    with a fresh connection. This fires once per attempt (never once per SSE event), so it cannot
  //    resurrect the abort-storm that queueRefresh/pendingBackgroundRefresh exist to prevent.
  //  - otherwise: retry only if a background trigger (SSE/poll/visibility) arrived and coalesced
  //    while this attempt was running (pendingBackgroundRefresh) — this also means a trigger that
  //    lands mid-refresh() is drained before refresh()'s own promise resolves, instead of waiting
  //    for the next independent trigger.
  const runLoop = useCallback(async (foreground = false) => {
    for (;;) {
      if (!mounted.current) return;
      const controller = new AbortController();
      inFlight.current = controller;
      const result = await runFetch(controller);
      if (inFlight.current !== controller) return; // superseded by a newer refresh()/backgroundRefresh()
      inFlight.current = null;
      if (result === "deadline") {
        // An AWAITED foreground refresh() must not stay pending across retries: several mutation
        // flows `await refresh()` before clearing their busy state, and a persistently hung
        // /api/dashboard would otherwise wedge those toasts/`finally` blocks forever. The deadline
        // error is already surfaced by runFetch, so hand the immediate retry to a detached
        // background loop and let this foreground promise resolve. (A background trigger arriving
        // meanwhile still coalesces via pendingBackgroundRefresh — the detached loop drains it.)
        if (foreground) {
          void runLoop(false);
          return;
        }
        continue;
      }
      if (!pendingBackgroundRefresh.current) return;
      pendingBackgroundRefresh.current = false;
    }
  }, [runFetch]);

  // Explicit foreground refresh: the initial load and every user action/mutation (approve/reject,
  // place/cancel an order, save a setting, etc. — everything callers pull `refresh` from
  // useConsoleData() for). The caller wants strictly fresh data right now, so this aborts and
  // replaces whatever is in flight (background or foreground).
  const refresh = useCallback(async () => {
    pendingBackgroundRefresh.current = false;
    inFlight.current?.abort();
    await runLoop(true);
  }, [runLoop]);

  // Background refresh: SSE events, the poll interval, and tab-visibility resync. Must NEVER abort
  // an in-flight fetch — that abort-storm was the root cause of the console taking minutes to
  // first-paint: during an active scan, SSE market-data/run-complete events (and the poll interval)
  // fire every few seconds, so the slow initial fetch kept getting killed and restarted before it
  // could ever finish, until a quiet gap happened to appear. If a fetch is already in flight, just
  // mark that a refresh was requested and let it finish (or hit its own deadline) — runLoop above
  // drains that flag on its own once the in-flight attempt settles, coalescing any number of
  // triggers that arrived in the meantime into a single extra fetch.
  const backgroundRefresh = useCallback(async () => {
    if (inFlight.current) {
      pendingBackgroundRefresh.current = true;
      return;
    }
    await runLoop();
  }, [runLoop]);

  const queueRefresh = useCallback(() => {
    if (typeof window === "undefined") return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    if (queuedRefresh.current) window.clearTimeout(queuedRefresh.current);
    queuedRefresh.current = window.setTimeout(() => {
      queuedRefresh.current = null;
      void backgroundRefresh();
    }, EVENT_REFRESH_DEBOUNCE_MS);
  }, [backgroundRefresh]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void backgroundRefresh();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void backgroundRefresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      mounted.current = false;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      if (queuedRefresh.current) clearTimeout(queuedRefresh.current);
      inFlight.current?.abort();
    };
  }, [refresh, backgroundRefresh]);

  // First-load watchdog: self-contained, independent of refresh()/the effect above. While no
  // snapshot has arrived and no error has been reported yet, arm a timer; if it fires first, flip to
  // the existing error card (which already auto-retries via the poll interval) instead of sitting on
  // the shell's logo forever. Re-armed automatically by its own [snapshot, error] deps — a snapshot
  // or error arriving before the deadline clears the pending timer via the effect cleanup.
  useEffect(() => {
    if (snapshot !== null || error !== null) return;
    const timer = window.setTimeout(() => {
      setError((prev) => prev ?? FIRST_LOAD_WATCHDOG_MESSAGE);
    }, FIRST_LOAD_WATCHDOG_MS);
    return () => window.clearTimeout(timer);
  }, [snapshot, error]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") {
      setStream(UNSUPPORTED_STREAM);
      return;
    }
    setStream((prev) => ({ ...prev, status: "connecting" }));
    const events = new EventSource("/api/events/stream");

    const markConnected = () => {
      if (!mounted.current) return;
      const now = new Date();
      setStream((prev) => ({
        ...prev,
        status: "live",
        connectedAt: now,
        lastErrorAt: null
      }));
    };

    const markEvent = (type: string) => {
      if (!mounted.current) return;
      const now = new Date();
      setStream((prev) => ({
        ...prev,
        status: "live",
        connectedAt: prev.connectedAt ?? now,
        lastEventAt: now,
        lastEventType: type,
        lastErrorAt: null
      }));
      queueRefresh();
    };

    const refreshTypes = ["ready", "run-complete", "order", "proposal", "dirty", "market-data", "pending-learned-change"] as const;
    const handlers = refreshTypes.map((type) => {
      const handler = () => markEvent(type);
      events.addEventListener(type, handler);
      return { type, handler };
    });

    events.onopen = markConnected;
    events.onerror = () => {
      if (!mounted.current) return;
      setStream((prev) => ({
        ...prev,
        status: prev.status === "unsupported" ? "unsupported" : "reconnecting",
        lastErrorAt: new Date()
      }));
    };

    return () => {
      for (const { type, handler } of handlers) events.removeEventListener(type, handler);
      events.close();
    };
  }, [queueRefresh]);

  const value = useMemo<ConsoleData>(
    () => ({ snapshot, fetchedAt, loading: snapshot === null && error === null, error, stream, refresh }),
    [snapshot, fetchedAt, error, stream, refresh]
  );

  return <ConsoleDataContext.Provider value={value}>{children}</ConsoleDataContext.Provider>;
}

export function useConsoleData(): ConsoleData {
  const ctx = useContext(ConsoleDataContext);
  if (!ctx) throw new Error("useConsoleData must be used inside ConsoleDataProvider");
  return ctx;
}
