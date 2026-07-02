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

export interface ConsoleData {
  snapshot: DashboardSnapshot | null;
  /** When the current snapshot was fetched (client clock). */
  fetchedAt: Date | null;
  /** True only before the very first snapshot arrives. */
  loading: boolean;
  /** Last fetch error (the previous snapshot stays rendered). */
  error: string | null;
  /** Force a refetch now (used after every mutation). */
  refresh: () => Promise<void>;
}

const ConsoleDataContext = createContext<ConsoleData | null>(null);

export function ConsoleDataProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
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

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void refresh();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      mounted.current = false;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      inFlight.current?.abort();
    };
  }, [refresh]);

  const value = useMemo<ConsoleData>(
    () => ({ snapshot, fetchedAt, loading: snapshot === null && error === null, error, refresh }),
    [snapshot, fetchedAt, error, refresh]
  );

  return <ConsoleDataContext.Provider value={value}>{children}</ConsoleDataContext.Provider>;
}

export function useConsoleData(): ConsoleData {
  const ctx = useContext(ConsoleDataContext);
  if (!ctx) throw new Error("useConsoleData must be used inside ConsoleDataProvider");
  return ctx;
}
