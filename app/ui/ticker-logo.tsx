"use client";

import { useMemo, useState, type ReactNode } from "react";
import type { TickerLogoDisplay } from "@/lib/ticker-logos";
import { normalizeTickerLogoSymbol } from "@/lib/ticker-logos";
import { cn } from "./cn";

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

  if (!normalized || display === "off" || failed) {
    return fallback ? <>{fallback}</> : null;
  }

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden",
        sizeClass[size],
        display === "tile" ? "rounded-md border border-line bg-surface-2/80 p-0.5" : "rounded-sm",
        className
      )}
      title={title}
      aria-hidden="true"
    >
      <img
        src={`/api/logos/ticker?symbol=${encodeURIComponent(normalized)}`}
        alt=""
        className="h-full w-full object-contain"
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
      />
    </span>
  );
}
