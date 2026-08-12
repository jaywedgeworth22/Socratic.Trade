"use client";

import Link from "next/link";
import { ExternalLink, Loader2, LogOut, RefreshCw, Smartphone } from "lucide-react";
import type { MobileCommandAvailability, MobileSnapshot, MobileSnapshotFreshness } from "../mobile-pwa-client";

export function MobileHeader({
  snapshot,
  snapshotFreshness,
  commandAvailability,
  busyCommand,
  connectedAccounts,
  onRefresh,
  onAccountChange
}: {
  snapshot: MobileSnapshot;
  snapshotFreshness: MobileSnapshotFreshness;
  commandAvailability: MobileCommandAvailability;
  busyCommand: string | null;
  connectedAccounts: Array<{ id: string; label: string; broker: string; environment: string; isActive: boolean; accountNumber?: string }>;
  onRefresh: () => void;
  onAccountChange: (id: string) => void;
}) {
  const activeAccountId = connectedAccounts.find((a) => a.isActive)?.id ?? "";

  return (
    <header className="sticky top-0 z-20 border-b border-line bg-bg/95 px-4 pt-[calc(env(safe-area-inset-top)+12px)] backdrop-blur">
      <div className="mx-auto flex max-w-xl items-center justify-between gap-3 pb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-faint">
            <Smartphone className="h-3.5 w-3.5" />
            Mobile control
          </div>
          <h1 className="truncate text-lg font-semibold">Socratic Trade</h1>
          <p className="truncate text-xs text-muted">Control remote — full desk on desktop/console</p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/console"
            className="grid h-11 w-11 place-items-center rounded-md border border-line bg-surface text-muted active:scale-95"
            aria-label="Open full console"
            title="Open the full desktop console"
          >
            <ExternalLink className="h-5 w-5" />
          </Link>
          <button
            className="grid h-11 w-11 place-items-center rounded-md border border-line bg-surface text-muted active:scale-95 disabled:opacity-50"
            disabled={snapshotFreshness === "refreshing"}
            onClick={onRefresh}
            aria-label="Refresh mobile snapshot"
            title="Refresh"
          >
            <RefreshCw className={`h-5 w-5 ${snapshotFreshness === "refreshing" ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {connectedAccounts.length > 0 && (
        <div className="mx-auto flex max-w-xl items-center gap-2 pb-3 pt-1">
          <div className="relative min-w-0 flex-1">
            <select
              className="min-h-10 w-full appearance-none rounded-md border border-line bg-surface px-3 py-1.5 pr-8 text-sm font-medium text-fg outline-none focus:border-accent disabled:opacity-50"
              value={activeAccountId}
              disabled={!commandAvailability.canSubmitAccountSwitch || busyCommand === "account.activate"}
              onChange={(e) => {
                const selectedId = e.target.value;
                if (!selectedId || selectedId === activeAccountId) return;
                onAccountChange(selectedId);
              }}
              aria-label="Select connected account"
            >
              {connectedAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.label} ({account.broker} · {account.environment}
                  {account.accountNumber ? ` · ${account.accountNumber}` : ""})
                  {account.isActive ? " ✓ Active" : ""}
                </option>
              ))}
            </select>
            <div className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted">
              {busyCommand === "account.activate" ? (
                <Loader2 className="h-4 w-4 animate-spin text-accent" />
              ) : (
                <span className="text-xs">▼</span>
              )}
            </div>
          </div>

          {snapshot?.currentUser?.email && (
            <a
              href="/logout"
              className="flex min-h-10 shrink-0 items-center gap-1.5 rounded-md border border-line bg-surface px-3 text-xs font-semibold text-muted hover:text-fg active:scale-95"
              title={`Sign out (${snapshot.currentUser.email})`}
            >
              <LogOut className="h-3.5 w-3.5" />
              <span>Sign out</span>
            </a>
          )}
        </div>
      )}
    </header>
  );
}
