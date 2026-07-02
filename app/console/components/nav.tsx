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
  Inbox,
  LayoutDashboard,
  MoreHorizontal,
  Settings as SettingsIcon,
  Shield
} from "lucide-react";
import { Sheet } from "../ui/sheet";
import { cx } from "../lib/format";

interface Destination {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
}

const DESTINATIONS: Destination[] = [
  { href: "/console", label: "Home", icon: LayoutDashboard },
  { href: "/console/approvals", label: "Approvals", icon: Inbox },
  { href: "/console/activity", label: "Activity", icon: ActivityIcon },
  { href: "/console/strategy", label: "Strategy", icon: Brain },
  { href: "/console/guardrails", label: "Guardrails", icon: Shield },
  { href: "/console/results", label: "Results", icon: BarChart3 },
  { href: "/console/settings", label: "Settings", icon: SettingsIcon }
];

function isActive(pathname: string, href: string): boolean {
  return href === "/console" ? pathname === "/console" : pathname.startsWith(href);
}

export function DesktopRail({ pendingCount }: { pendingCount: number }) {
  const pathname = usePathname() ?? "";
  return (
    <nav className="hidden w-52 shrink-0 flex-col gap-1 px-3 py-4 lg:flex" aria-label="Console navigation">
      {DESTINATIONS.map((d) => {
        const Icon = d.icon;
        return (
          <Link key={d.href} href={d.href} className="con-nav-item" data-active={isActive(pathname, d.href)}>
            <Icon size={16} />
            <span className="flex-1">{d.label}</span>
            {d.href === "/console/approvals" && pendingCount > 0 && <span className="con-badge">{pendingCount}</span>}
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
              <Link key={d.href} href={d.href} className="con-tab-item" data-active={isActive(pathname, d.href)}>
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
          <button type="button" className={cx("con-tab-item")} data-active={moreActive} onClick={() => setMoreOpen(true)}>
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
                onClick={() => setMoreOpen(false)}
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
