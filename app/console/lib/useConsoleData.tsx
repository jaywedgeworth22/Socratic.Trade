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

  const runFetch = useCallback(async (controller: AbortController) => {
    try {
      const data = await fetchDashboard<DashboardSnapshot>(controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      setSnapshot(data);
      setFetchedAt(new Date());
      setError(null);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (!mounted.current) return;
      setError(err instanceof ConsoleApiError ? err.message : "Could not refresh data.");
    }
  }, []);

  // Explicit foreground refresh: the initial load and every user action/mutation (approve/reject,
  // place/cancel an order, save a setting, etc. — everything callers pull `refresh` from
  // useConsoleData() for). The caller wants strictly fresh data right now, so this aborts and
  // replaces whatever is in flight (background or foreground) and any coalesced background request
  // that was waiting is moot once this fetch lands.
  const refresh = useCallback(async () => {
    pendingBackgroundRefresh.current = false;
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    await runFetch(controller);
    if (inFlight.current === controller) inFlight.current = null;
  }, [runFetch]);

  // Background refresh: SSE events, the poll interval, and tab-visibility resync. Must NEVER abort
  // an in-flight fetch — that abort-storm was the root cause of the console taking minutes to
  // first-paint: during an active scan, SSE market-data/run-complete events (and the poll interval)
  // fire every few seconds, so the slow initial fetch kept getting killed and restarted before it
  // could ever finish, until a quiet gap happened to appear. If a fetch is already in flight, just
  // mark that a refresh was requested and let the in-flight one finish; once it settles (and only if
  // this call still owns `inFlight` — an explicit refresh() may have superseded it), run exactly one
  // more fetch when a background refresh is still pending, coalescing any number of triggers that
  // arrived in the meantime into a single extra fetch.
  const backgroundRefresh = useCallback(async () => {
    if (inFlight.current) {
      pendingBackgroundRefresh.current = true;
      return;
    }
    for (;;) {
      const controller = new AbortController();
      inFlight.current = controller;
      await runFetch(controller);
      if (inFlight.current !== controller) return; // superseded by an explicit refresh()
      inFlight.current = null;
      if (!pendingBackgroundRefresh.current) return;
      pendingBackgroundRefresh.current = false;
    }
  }, [runFetch]);

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

    const markEvent = (type: string, raw?: string) => {
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
      if (type === "market-data") {
        let detail: unknown = undefined;
        if (raw) {
          try {
            detail = JSON.parse(raw);
          } catch {
            detail = raw;
          }
        }
        window.dispatchEvent(new CustomEvent("market-data-filled", { detail }));
      }
      queueRefresh();
    };

    const refreshTypes = ["ready", "run-complete", "order", "proposal", "dirty", "market-data", "pending-learned-change"] as const;
    const handlers = refreshTypes.map((type) => {
      const handler = (event: MessageEvent) => markEvent(type, event.data);
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
