"use client";

// Admin portal shell — same design system as the console (con-* tokens via
// console.css + .console-root scope), same nav idiom (DesktopRail geometry),
// but a distinct operator frame: no trading chrome, no snapshot fetch, and an
// always-visible "← Console" return link as the FIRST control in the top bar.

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Activity,
  Brain,
  Database,
  Server,
  FileText,
  ArrowLeft,
  ShieldCheck,
  Menu,
  X
} from "lucide-react";
import "../console/console.css";
import { useConsoleTheme } from "../console/lib/useConsoleTheme";
import { useConsoleFont } from "../console/lib/useConsoleFont";
import { useConsoleTextBoxFont } from "../console/lib/useConsoleTextBoxFont";

interface NavItem {
  href: string;
  label: string;
  desc: string;
  icon: React.ComponentType<{ size?: number | string; className?: string }>;
  exact?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  {
    href: "/admin",
    label: "Overview",
    desc: "Server-wide status: connections, spend, corpus, host, and transcripts at a glance.",
    icon: LayoutDashboard,
    exact: true
  },
  {
    href: "/admin/connections",
    label: "API connections",
    desc: "Per-provider call health: last success/failure, call volume, and error patterns.",
    icon: Activity
  },
  {
    href: "/admin/llm-usage",
    label: "LLM usage & cost",
    desc: "Per-key, per-model, per-context LLM spend across all accounts.",
    icon: Brain
  },
  {
    href: "/admin/rag-coverage",
    label: "RAG coverage",
    desc: "Vector index contents per ticker: chunk counts, freshness, and coverage gaps.",
    icon: Database
  },
  {
    href: "/admin/server",
    label: "Server & infrastructure",
    desc: "Host node metrics and Coolify application resource statuses.",
    icon: Server
  },
  {
    href: "/admin/transcript",
    label: "Chat transcript",
    desc: "Every chat turn, with the model that produced each assistant reply.",
    icon: FileText
  }
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const { dataTheme } = useConsoleTheme();
  const { dataConsoleFont } = useConsoleFont();
  const { dataTextBoxFont } = useConsoleTextBoxFont();

  const isActive = (item: NavItem) => {
    if (item.exact) return pathname === item.href;
    return pathname.startsWith(item.href) && pathname !== "/admin";
  };
  const activeItem = NAV_ITEMS.find(isActive);

  const navLinks = (onNavigate?: () => void) =>
    NAV_ITEMS.map((item) => {
      const Icon = item.icon;
      const active = isActive(item);
      return (
        <Link
          key={item.href}
          href={item.href}
          className="con-nav-item"
          data-active={active}
          aria-current={active ? "page" : undefined}
          title={item.desc}
          onClick={onNavigate}
        >
          <Icon size={16} />
          <span>{item.label}</span>
        </Link>
      );
    });

  return (
    <div
      className="console-root flex min-h-dvh flex-col"
      data-theme={dataTheme}
      data-console-font={dataConsoleFont}
      data-textbox-font={dataTextBoxFont}
      suppressHydrationWarning /* same SSR-vs-localStorage pattern as the console shell */
    >
      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-40 border-b border-[color:var(--con-line)] bg-[color:var(--con-surface)]">
        <div className="mx-auto flex h-12 max-w-[1400px] items-center gap-2 px-4">
          <button
            type="button"
            onClick={() => setMobileMenuOpen((open) => !open)}
            className="-ml-2 flex h-11 w-11 items-center justify-center rounded-[var(--con-radius-sm)] text-[color:var(--con-muted)] transition-colors hover:text-[color:var(--con-fg)] lg:hidden"
            aria-label="Toggle admin navigation"
            aria-expanded={mobileMenuOpen}
          >
            {mobileMenuOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
          {/* Return to the console — first control, always visible at every breakpoint. */}
          <Link href="/console" className="con-btn con-btn-ghost con-btn-sm" title="Back to the trading console">
            <ArrowLeft size={14} />
            Console
          </Link>
          <div className="flex min-w-0 items-center gap-2">
            <ShieldCheck size={15} className="shrink-0 text-[color:var(--con-accent)]" />
            <span className="con-card-title">Admin</span>
            <span className="truncate text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
              {activeItem?.label ?? "Overview"}
            </span>
          </div>
        </div>
      </header>

      {/* ── Mobile navigation drawer (top bar stays visible above it) ────── */}
      {mobileMenuOpen && (
        <div
          className="con-scrim lg:hidden"
          style={{ top: 48, zIndex: 30 }}
          onClick={() => setMobileMenuOpen(false)}
        >
          <div
            className="absolute inset-y-0 left-0 flex w-64 flex-col gap-1 border-r border-[color:var(--con-line)] bg-[color:var(--con-surface)] p-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="con-card-title px-3 pb-1">Operator</div>
            {navLinks(() => setMobileMenuOpen(false))}
          </div>
        </div>
      )}

      {/* ── Rail + content ───────────────────────────────────────────────── */}
      <div className="mx-auto flex w-full max-w-[1400px] flex-1">
        <aside
          className="hidden w-52 shrink-0 flex-col gap-1 border-r border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] px-3 py-4 shadow-sm lg:flex mr-4"
          aria-label="Admin navigation"
        >
          <div className="con-card-title px-3 pb-1">Operator</div>
          {navLinks()}
        </aside>
        <main className="min-w-0 flex-1 px-4 pt-4 pb-8 lg:px-6">{children}</main>
      </div>
    </div>
  );
}
