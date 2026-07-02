"use client";

/** Destinations: left rail on desktop (≥1024px), bottom tab bar on mobile.
 *  Approvals carries the console's only red badge. */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  Activity as ActivityIcon,
  BarChart3,
  Brain,
  Globe,
  Inbox,
  LayoutDashboard,
  ListChecks,
  MessageSquare,
  MoreHorizontal,
  Radar,
  Settings as SettingsIcon,
  Shield
} from "lucide-react";
import { Sheet } from "../ui/sheet";
import { cx } from "../lib/format";
import { useNavDirtyGuard } from "../lib/useDirtyGuard";

interface Destination {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  /** Concise hover explanation (native title) — every destination has one. */
  desc: string;
}

const DESTINATIONS: Destination[] = [
  { href: "/console", label: "Home", icon: LayoutDashboard, desc: "Account overview: portfolio, positions, and what needs attention." },
  { href: "/console/approvals", label: "Approvals", icon: Inbox, desc: "Pending trade proposals waiting for your decision." },
  { href: "/console/activity", label: "Activity", icon: ActivityIcon, desc: "Everything that happened, newest first." },
  { href: "/console/scan", label: "Scan", icon: Radar, desc: "The market scan: screened and scored symbols from the latest run." },
  { href: "/console/macro", label: "Macro", icon: Globe, desc: "Macro and market-regime board: rates, credit, volatility, breadth." },
  { href: "/console/orders", label: "Orders", icon: ListChecks, desc: "Order history and open orders at the broker." },
  { href: "/console/assistant", label: "Assistant", icon: MessageSquare, desc: "Chat with the assistant about your accounts and the market." },
  { href: "/console/strategy", label: "Strategy", icon: Brain, desc: "The strategy prompt, models, and run cadence." },
  { href: "/console/guardrails", label: "Guardrails", icon: Shield, desc: "Hard limits the policy gate enforces on every trade." },
  { href: "/console/results", label: "Results", icon: BarChart3, desc: "Realized performance, equity curve, and thesis scorecards." },
  { href: "/console/settings", label: "Settings", icon: SettingsIcon, desc: "Accounts, notifications, API keys, and console preferences." }
];

function isActive(pathname: string, href: string): boolean {
  return href === "/console" ? pathname === "/console" : pathname.startsWith(href);
}

export function DesktopRail({ pendingCount }: { pendingCount: number }) {
  const pathname = usePathname() ?? "";
  const guardNav = useNavDirtyGuard();
  return (
    <nav className="hidden w-52 shrink-0 flex-col gap-1 px-3 py-4 lg:flex" aria-label="Console navigation">
      {DESTINATIONS.map((d) => {
        const Icon = d.icon;
        return (
          <Link
            key={d.href}
            href={d.href}
            className="con-nav-item"
            data-active={isActive(pathname, d.href)}
            title={d.desc}
            onClick={(e) => guardNav(e)}
          >
            <Icon size={16} />
            <span className="flex-1">{d.label}</span>
            {d.href === "/console/approvals" && pendingCount > 0 && (
              <span className="con-badge" title={`${pendingCount} proposal${pendingCount === 1 ? "" : "s"} waiting for your decision`}>
                {pendingCount}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

const MOBILE_PRIMARY = DESTINATIONS.slice(0, 3);
const MOBILE_MORE = DESTINATIONS.slice(3);

export function MobileTabBar({ pendingCount }: { pendingCount: number }) {
  const pathname = usePathname() ?? "";
  const [moreOpen, setMoreOpen] = useState(false);
  const guardNav = useNavDirtyGuard();
  const moreActive = MOBILE_MORE.some((d) => isActive(pathname, d.href));

  return (
    <>
      <nav
        className="fixed inset-x-0 bottom-0 z-50 border-t border-[color:var(--con-line-strong)] bg-[color:var(--con-surface)] lg:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        aria-label="Console navigation"
      >
        <div className="flex">
          {MOBILE_PRIMARY.map((d) => {
            const Icon = d.icon;
            return (
              <Link
                key={d.href}
                href={d.href}
                className="con-tab-item"
                data-active={isActive(pathname, d.href)}
                title={d.desc}
                onClick={(e) => guardNav(e)}
              >
                <span className="relative">
                  <Icon size={19} />
                  {d.href === "/console/approvals" && pendingCount > 0 && (
                    <span className="con-badge absolute -right-2.5 -top-1.5">{pendingCount}</span>
                  )}
                </span>
                {d.label}
              </Link>
            );
          })}
          <button
            type="button"
            className={cx("con-tab-item")}
            data-active={moreActive}
            title="All remaining console screens"
            onClick={() => setMoreOpen(true)}
          >
            <MoreHorizontal size={19} />
            More
          </button>
        </div>
      </nav>

      <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} title="More">
        <div className="flex flex-col gap-1">
          {MOBILE_MORE.map((d) => {
            const Icon = d.icon;
            return (
              <Link
                key={d.href}
                href={d.href}
                className="con-nav-item"
                data-active={isActive(pathname, d.href)}
                title={d.desc}
                onClick={(e) => {
                  if (guardNav(e)) setMoreOpen(false);
                }}
              >
                <Icon size={16} />
                {d.label}
              </Link>
            );
          })}
        </div>
      </Sheet>
    </>
  );
}
