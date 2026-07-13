"use client";

import { useEffect, useState } from "react";
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
  Clock,
  ShieldCheck,
  Menu,
  X
} from "lucide-react";
import { cn } from "../ui/cn";
import { Button } from "../ui/primitives";

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<any>;
  exact?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/admin", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { href: "/admin/connections", label: "API Connections", icon: Activity },
  { href: "/admin/llm-usage", label: "LLM Spend & Costs", icon: Brain },
  { href: "/admin/rag-coverage", label: "RAG Coverage", icon: Database },
  { href: "/admin/server", label: "Server & Infra", icon: Server },
  { href: "/admin/transcript", label: "Chat Transcripts", icon: FileText }
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [timeStr, setTimeStr] = useState("");

  useEffect(() => {
    const update = () => {
      setTimeStr(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, []);

  const isActive = (item: NavItem) => {
    if (item.exact) return pathname === item.href;
    return pathname.startsWith(item.href) && pathname !== "/admin";
  };

  return (
    <div className="flex min-h-screen bg-base text-fg font-sans antialiased">
      {/* ── Desktop Sidebar ─────────────────────────────────────────────────── */}
      <aside className="hidden md:flex w-64 flex-col border-r border-line/40 bg-surface/40 backdrop-blur-md shrink-0">
        <div className="flex h-14 items-center justify-between border-b border-line/30 px-6">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-accent" />
            <span className="font-bold text-sm tracking-wider uppercase text-fg">Socratic Admin</span>
          </div>
        </div>

        <nav className="flex-1 space-y-1.5 px-4 py-6">
          {NAV_ITEMS.map((item) => {
            const ActiveIcon = item.icon;
            const active = isActive(item);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-xl transition-all duration-150 border-l-2",
                  active
                    ? "bg-accent/8 border-accent text-accent"
                    : "border-transparent text-muted hover:text-fg hover:bg-surface-2/50"
                )}
              >
                <ActiveIcon className={cn("h-4 w-4 shrink-0", active ? "text-accent" : "text-muted")} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-line/20 flex flex-col gap-2">
          <Link href="/console" className="w-full">
            <Button variant="ghost" size="sm" className="w-full justify-start text-xs text-muted hover:text-fg border border-line/40 rounded-xl">
              <ArrowLeft className="h-3 w-3 mr-1" />
              Autonomy Desk
            </Button>
          </Link>
        </div>
      </aside>

      {/* ── Main Content Shell ─────────────────────────────────────────────── */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Sticky Topbar */}
        <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-line/30 bg-surface/30 backdrop-blur-md px-6">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="md:hidden p-1 text-muted hover:text-fg transition-colors"
              aria-label="Toggle menu"
            >
              {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
            <h2 className="text-sm font-semibold text-fg md:block hidden">
              {NAV_ITEMS.find(isActive)?.label ?? "Operator Hub"}
            </h2>
          </div>

          <div className="flex items-center gap-4 text-xs text-muted">
            <div className="flex items-center gap-1.5 bg-surface-2/60 border border-line/30 rounded-full px-2.5 py-1 font-mono font-medium">
              <Clock className="h-3.5 w-3.5 text-accent animate-pulse" />
              <span>{timeStr || "--:--:--"}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-pos opacity-70" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-pos" />
              </span>
              <span className="font-semibold text-fg">LIVE</span>
            </div>
          </div>
        </header>

        {/* Mobile Navigation Drawer */}
        {mobileMenuOpen && (
          <div className="md:hidden fixed inset-0 z-30 bg-base/80 backdrop-blur-sm" onClick={() => setMobileMenuOpen(false)}>
            <div
              className="absolute top-14 left-0 bottom-0 w-64 border-r border-line bg-surface/90 flex flex-col p-4 space-y-1.5"
              onClick={(e) => e.stopPropagation()}
            >
              {NAV_ITEMS.map((item) => {
                const ActiveIcon = item.icon;
                const active = isActive(item);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setMobileMenuOpen(false)}
                    className={cn(
                      "flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-xl border-l-2",
                      active
                        ? "bg-accent/8 border-accent text-accent"
                        : "border-transparent text-muted hover:text-fg"
                    )}
                  >
                    <ActiveIcon className={cn("h-4 w-4 shrink-0", active ? "text-accent" : "text-muted")} />
                    <span>{item.label}</span>
                  </Link>
                );
              })}

              <div className="mt-auto border-t border-line/20 pt-4 flex flex-col gap-2">
                <Link href="/console" onClick={() => setMobileMenuOpen(false)} className="w-full">
                  <Button variant="ghost" size="sm" className="w-full justify-start text-xs border border-line/40 rounded-xl">
                    <ArrowLeft className="h-3 w-3 mr-1" />
                    Autonomy Desk
                  </Button>
                </Link>
              </div>
            </div>
          </div>
        )}

        {/* Main Content Area */}
        <main className="flex-1 p-6 md:p-8 max-w-5xl w-full mx-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
