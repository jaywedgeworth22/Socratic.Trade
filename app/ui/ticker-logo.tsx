"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { TickerLogoDisplay } from "@/lib/ticker-logos";
import { normalizeTickerLogoSymbol } from "@/lib/ticker-logos";
import { cn } from "./cn";

function useDarkMode(): "dark" | "light" {
  const [theme, setTheme] = useState<"dark" | "light">("dark"); // default dark for SSR

  useEffect(() => {
    const el = document.documentElement;
    const update = () => setTheme(el.classList.contains("dark") ? "dark" : "light");
    update();
    const observer = new MutationObserver(update);
    observer.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return theme;
}

type TickerLogoSize = "sm" | "md" | "lg";

const sizeClass: Record<TickerLogoSize, string> = {
  sm: "h-5 w-5",
  md: "h-7 w-7",
  lg: "h-12 w-12"
};

export function TickerLogo({
  symbol,
  display,
  size = "sm",
  className,
  title,
  fallback
}: {
  symbol: string;
  display: TickerLogoDisplay;
  size?: TickerLogoSize;
  className?: string;
  title?: string;
  fallback?: ReactNode;
}) {
  const normalized = useMemo(() => normalizeTickerLogoSymbol(symbol), [symbol]);
  const [failed, setFailed] = useState(false);
  const theme = useDarkMode();

  if (!normalized || display === "off" || failed) {
    return fallback ? <>{fallback}</> : null;
  }

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden",
        sizeClass[size],
        // Dark tile in light mode so white/transparent-glyph logos (e.g. AAPL) stay
        // visible; keep the translucent surface tile in dark mode.
        display === "tile" ? "rounded-md border border-line bg-slate-700 p-0.5 dark:bg-surface-2/80" : "rounded-sm",
        className
      )}
      title={title}
      aria-hidden="true"
    >
      <img
        src={`/api/logos/ticker?symbol=${encodeURIComponent(normalized)}&theme=${theme}`}
        alt=""
        className="h-full w-full object-contain"
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
      />
    </span>
  );
}
