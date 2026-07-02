"use client";

/** The console shell: providers + global chrome + navigation. Every screen
 *  renders inside this frame, so money-reality, run state, STOP, Run once,
 *  and freshness are visible everywhere. LIVE reality adds a viewport frame
 *  (console-live) — words first, color as reinforcement. */

import type { ReactNode } from "react";
import type { DashboardSnapshot } from "../../dashboard-types";
import { deriveReality } from "../lib/derive";
import { cx } from "../lib/format";
import { ConsoleDataProvider, useConsoleData } from "../lib/useConsoleData";
import { ToastProvider } from "../ui/toast";
import { FreshnessStrip, RealityBanner, RunOnceButton, ScopeSelector, StateChip, StopButton } from "./chrome";
import { DesktopRail, MobileTabBar } from "./nav";

export function ConsoleShell({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <ConsoleDataProvider>
        <ShellFrame>{children}</ShellFrame>
      </ConsoleDataProvider>
    </ToastProvider>
  );
}

function ShellFrame({ children }: { children: ReactNode }) {
  const { snapshot, fetchedAt, loading, error } = useConsoleData();

  if (loading) {
    return (
      <div className="console-root flex min-h-dvh items-center justify-center">
        <div className="text-center">
          <div className="con-card-title">Console</div>
          <p className="mt-2 text-[color:var(--con-muted)]">Loading account data…</p>
        </div>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="console-root flex min-h-dvh items-center justify-center px-6">
        <div className="con-card max-w-md p-6 text-center">
          <div className="con-card-title">Console</div>
          <p className="mt-2 font-semibold">Couldn&apos;t load account data</p>
          <p className="mt-1 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
            {error ?? "The dashboard API did not respond."} The console retries automatically.
          </p>
        </div>
      </div>
    );
  }

  const reality = deriveReality(snapshot);

  return (
    <div className={cx("console-root flex min-h-dvh flex-col", reality.tone === "live" && "console-live")}>
      <RealityBanner snapshot={snapshot} />
      <ChromeBar snapshot={snapshot} />
      <div className="mx-auto flex w-full max-w-[1400px] flex-1">
        <DesktopRail pendingCount={snapshot.pendingProposals.length} />
        <main className="min-w-0 flex-1 px-4 pb-24 pt-4 lg:px-6 lg:pb-8">{children}</main>
      </div>
      <FreshnessStrip snapshot={snapshot} fetchedAt={fetchedAt} error={error} />
      <MobileTabBar pendingCount={snapshot.pendingProposals.length} />
    </div>
  );
}

function ChromeBar({ snapshot }: { snapshot: DashboardSnapshot }) {
  return (
    <header className="border-b border-[color:var(--con-line)] bg-[color:var(--con-surface)]">
      <div className="mx-auto flex max-w-[1400px] items-center gap-2 px-4 py-2">
        <span className="hidden pr-2 text-[length:var(--con-fs-md)] font-bold tracking-tight lg:block">Console</span>
        <ScopeSelector snapshot={snapshot} />
        <StateChip snapshot={snapshot} />
        <div className="flex-1" />
        <div className="hidden sm:block">
          <RunOnceButton snapshot={snapshot} />
        </div>
        <StopButton snapshot={snapshot} />
      </div>
    </header>
  );
}
