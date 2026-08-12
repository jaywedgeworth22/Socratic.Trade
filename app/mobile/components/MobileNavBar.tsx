"use client";

import { Inbox, LayoutDashboard } from "lucide-react";

export type MobileTab = "home" | "proposals";

export function MobileNavBar({
  activeTab,
  onTabChange,
  pendingCount = 0
}: {
  activeTab: MobileTab;
  onTabChange: (tab: MobileTab) => void;
  pendingCount?: number;
}) {
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-bg/95 backdrop-blur overscroll-contain pb-[env(safe-area-inset-bottom,0px)]"
      aria-label="Mobile navigation"
    >
      <div className="mx-auto flex max-w-xl items-center justify-around py-2">
        <button
          type="button"
          className={`flex flex-1 flex-col items-center justify-center py-1 text-xs font-medium transition-colors ${
            activeTab === "home" ? "text-accent font-bold" : "text-muted hover:text-fg"
          }`}
          onClick={() => onTabChange("home")}
          aria-current={activeTab === "home" ? "page" : undefined}
        >
          <LayoutDashboard className="h-5 w-5 mb-0.5" />
          <span>Overview</span>
        </button>

        <button
          type="button"
          className={`relative flex flex-1 flex-col items-center justify-center py-1 text-xs font-medium transition-colors ${
            activeTab === "proposals" ? "text-accent font-bold" : "text-muted hover:text-fg"
          }`}
          onClick={() => onTabChange("proposals")}
          aria-current={activeTab === "proposals" ? "page" : undefined}
        >
          <div className="relative">
            <Inbox className="h-5 w-5 mb-0.5" />
            {pendingCount > 0 && (
              <span className="absolute -right-2.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">
                {pendingCount}
              </span>
            )}
          </div>
          <span>Proposals</span>
        </button>
      </div>
    </nav>
  );
}
