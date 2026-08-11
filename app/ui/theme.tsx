"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

type Theme = "light" | "dark";
const ThemeContext = createContext<{ theme: Theme; toggle: () => void; set: (t: Theme) => void }>({
  theme: "light",
  toggle: () => {},
  set: () => {}
});

/**
 * Inline script (run before paint) that applies the saved theme to <html> to
 * avoid a flash. Owner ruling 2026-08-10: default is LIGHT — never invent
 * dark from prefers-color-scheme when the user has not chosen a theme.
 * Only explicit localStorage "dark" (or a future explicit system path) goes dark.
 */
export const themeInitScript = `(function(){try{var t=localStorage.getItem('theme');if(t!=='dark'&&t!=='light'){t='light';}document.documentElement.classList.toggle('dark',t==='dark');document.documentElement.dataset.theme=t;}catch(e){document.documentElement.classList.remove('dark');document.documentElement.dataset.theme='light';}})();`;

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("light");

  useEffect(() => {
    const current = (document.documentElement.dataset.theme as Theme) || "light";
    setThemeState(current);
  }, []);

  const set = useCallback((next: Theme) => {
    setThemeState(next);
    document.documentElement.classList.toggle("dark", next === "dark");
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("theme", next);
    } catch {
      /* ignore */
    }
  }, []);

  const toggle = useCallback(() => set(theme === "dark" ? "light" : "dark"), [theme, set]);

  return <ThemeContext.Provider value={{ theme, toggle, set }}>{children}</ThemeContext.Provider>;
}

/** Currently has no callers — kept as the public API for a future public-page
 *  theme control. `ThemeToggle` (the only prior consumer) was deleted 2026-07-16
 *  as dead code. */
export function useTheme() {
  return useContext(ThemeContext);
}
