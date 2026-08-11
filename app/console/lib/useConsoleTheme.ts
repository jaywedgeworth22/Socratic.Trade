"use client";

/** Console-scoped theme: light by default (owner 2026-08-10), with optional
 *  dark or system choice persisted under a console-scoped key and applied via
 *  data-theme on the console root — so it can never clash with the legacy
 *  app's theming (.dark class on <html>). */

import { useCallback, useState } from "react";

export type ConsoleTheme = "system" | "light" | "dark";

const STORAGE_KEY = "console:theme";

function readStored(): ConsoleTheme {
  if (typeof window === "undefined") return "light";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
    // Missing / unknown → light (do not follow OS dark by default).
    return "light";
  } catch {
    return "light";
  }
}

export function useConsoleTheme(): {
  theme: ConsoleTheme;
  /** Value for the console root's data-theme attribute (undefined = follow system). */
  dataTheme: "light" | "dark" | undefined;
  cycle: () => void;
  set: (next: ConsoleTheme) => void;
} {
  const [theme, setThemeState] = useState<ConsoleTheme>(readStored);

  const set = useCallback((next: ConsoleTheme) => {
    setThemeState(next);
    try {
      if (next === "system") window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* private mode etc. — theme still applies for this session */
    }
  }, []);

  const cycle = useCallback(() => {
    setThemeState((prev) => {
      // light → dark → system → light (starts on light)
      const next: ConsoleTheme =
        prev === "light" ? "dark" : prev === "dark" ? "system" : "light";
      try {
        if (next === "system") window.localStorage.removeItem(STORAGE_KEY);
        else window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* private mode etc. — theme still applies for this session */
      }
      return next;
    });
  }, []);

  // Explicit light/dark win; system leaves data-theme unset so CSS can follow OS.
  return {
    theme,
    dataTheme: theme === "system" ? undefined : theme,
    cycle,
    set,
  };
}
