"use client";

import { cn } from "./cn";
import { ChevronRight } from "lucide-react";
import React from "react";

export function List({ children, className }: { children: React.ReactNode; className?: string }) {
  // Extra breathing room between sections on narrow (mobile) viewports, where the stacked
  // ListSections felt cramped; unchanged on sm+ so desktop density is untouched.
  return (
    <div className={cn("flex flex-col gap-8 sm:gap-6", className)}>
      {children}
    </div>
  );
}

// A Settings section renders as the SAME `con-card` primitive every other console page uses
// (Mandates, Scan, Results, …) — a standalone titled card with divided rows — instead of the old
// ad-hoc iOS grouped-list box. Scope grouping is handled by <SettingsGroup> (a light label, not a
// nested bordered box), so Settings no longer shows boxes-inside-boxes.
export function ListSection({ title, footer, action, children, className }: { title?: React.ReactNode; footer?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("con-card", className)}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 px-4 pt-3.5 pb-1">
          {title ? <h2 className="con-card-title">{title}</h2> : <span />}
          {action && <div className="text-[length:var(--con-fs-sm)]">{action}</div>}
        </header>
      )}
      <div className="flex flex-col divide-y divide-[color:var(--con-line)]">
        {children}
      </div>
      {footer && <div className="px-4 pt-2.5 pb-3.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)] leading-relaxed">{footer}</div>}
    </section>
  );
}

// Lightweight scope grouping for the Settings page (ALL YOUR ACCOUNTS / THIS BROWSER / DANGER …):
// a muted label above a stack of standalone cards, with an optional explanatory footer. Deliberately
// NOT a bordered container — that outer border is exactly what made Settings look nested and unlike
// every other page.
export function SettingsGroup({ label, footer, children, className }: { label?: React.ReactNode; footer?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("flex flex-col gap-3", className)}>
      {label && (
        <h2 className="px-1 text-[length:var(--con-fs-xs)] font-semibold tracking-wide text-[color:var(--con-muted)] uppercase">{label}</h2>
      )}
      <div className="flex flex-col gap-4">{children}</div>
      {footer && <div className="px-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)] leading-relaxed">{footer}</div>}
    </section>
  );
}

export function ListRow({ 
  children, 
  className,
  href,
  onClick
}: { 
  children: React.ReactNode; 
  className?: string;
  href?: string;
  onClick?: () => void;
}) {
  const Component = href ? "a" : onClick ? "button" : "div";
  const interactive = !!(href || onClick);
  
  return (
    <Component 
      href={href}
      onClick={onClick}
      className={cn(
        "flex min-h-[44px] w-full items-center px-4 py-2.5 text-[15px] bg-[color:var(--con-surface)]",
        interactive && "cursor-pointer transition-colors hover:bg-[color:var(--con-surface-2)] active:bg-[color:var(--con-surface-3)] text-left",
        className
      )}
    >
      {children}
    </Component>
  );
}

export function LabeledContent({ label, hint, value, icon, alignRight = true, children }: { label: React.ReactNode; hint?: React.ReactNode; value?: React.ReactNode; icon?: React.ReactNode; alignRight?: boolean; children?: React.ReactNode }) {
  return (
    <div className="flex w-full items-center justify-between gap-4">
      <div className="flex flex-col gap-0.5 shrink-0">
        <div className="flex items-center gap-3">
          {icon && <span className="text-[color:var(--con-muted)]">{icon}</span>}
          <span className="font-medium text-[color:var(--con-fg)]">{label}</span>
        </div>
        {hint && <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)] max-w-[280px] leading-relaxed">{hint}</span>}
      </div>
      <div className={cn("text-[color:var(--con-muted)]", alignRight ? "text-right" : "text-left")}>
        {children ?? value}
      </div>
    </div>
  );
}

export function NavigationLinkRow({ label, icon, value }: { label: string; icon?: React.ReactNode; value?: React.ReactNode }) {
  return (
    <div className="flex w-full items-center justify-between gap-4">
      <div className="flex items-center gap-3">
         {icon && <span className="text-[color:var(--con-accent)]">{icon}</span>}
         <span className="font-medium text-[color:var(--con-fg)]">{label}</span>
      </div>
      <div className="flex items-center gap-1.5 text-[color:var(--con-muted)]">
         {value && <span>{value}</span>}
         <ChevronRight size={16} className="opacity-50" />
      </div>
    </div>
  );
}

export function LargeTitle({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <h1 className={cn("text-[34px] font-bold tracking-tight text-[color:var(--con-fg)] mb-4 px-1 leading-tight", className)}>
      {children}
    </h1>
  );
}
