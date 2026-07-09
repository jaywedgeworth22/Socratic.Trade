"use client";

/** The console shell: providers + global chrome + navigation. Every screen
 *  renders inside this frame, so account scope, run state, STOP, Run once,
 *  and freshness are visible everywhere. Paper/no-account states get explicit
 *  banners; ordinary brokerage accounts do not get a red global frame. Theme: system
 *  preference by default, explicit light/dark via the chrome toggle
 *  (persisted, applied as data-theme on this root). */

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import type { DashboardSnapshot } from "../../dashboard-types";
import { ConsoleDataProvider, useConsoleData } from "../lib/useConsoleData";
import { useConsoleFont } from "../lib/useConsoleFont";
import { useConsoleTextBoxFont } from "../lib/useConsoleTextBoxFont";
import { useConsoleTheme, type ConsoleTheme } from "../lib/useConsoleTheme";
import { DirtyGuardProvider } from "../lib/useDirtyGuard";
import { SymbolDrawerProvider } from "../ui/symbol-drawer";
import { ToastProvider } from "../ui/toast";
import {
  FreshnessStrip,
  MobileFreshnessBar,
  RealityBanner,
  RunOnceButton,
  RunStateButton,
  ScopeSelector,
  StateChip,
  UserMenu
} from "./chrome";
import { CommandPalette, CommandPaletteTrigger } from "./command-palette";
import { ConsentGate } from "./consent-gate";
import { ConsoleIntro } from "./intro-canvas";
import { HeaderLogo } from "../ui/header-logo";
import { getIntroPhase, subscribeIntroPhase, type IntroPhase } from "../ui/intro-bus";
import { DesktopRail, MobileTabBar } from "./nav";

export function ConsoleShell({ children }: { children: ReactNode }) {
  return (
    <ConsoleDataProvider>
      {/* DirtyGuardProvider wraps the nav AND the pages so unsaved drafts can
          intercept both tab-close (beforeunload) and in-console navigation. */}
      <DirtyGuardProvider>
        <ShellFrame>{children}</ShellFrame>
      </DirtyGuardProvider>
    </ConsoleDataProvider>
  );
}

const THEME_LABEL: Record<ConsoleTheme, string> = {
  system: "Theme: following your system setting. Click for dark.",
  dark: "Theme: dark. Click for light.",
  light: "Theme: light. Click to follow your system setting."
};

function ThemeToggle({ theme, cycle }: { theme: ConsoleTheme; cycle: () => void }) {
  const Icon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
  return (
    <button
      type="button"
      onClick={cycle}
      title={THEME_LABEL[theme]}
      aria-label={THEME_LABEL[theme]}
      className="flex h-8 w-8 items-center justify-center rounded-lg border border-[color:var(--con-line-strong)] text-[color:var(--con-muted)] transition-colors hover:border-[color:var(--con-accent)] hover:text-[color:var(--con-accent)]"
    >
      <Icon size={15} />
    </button>
  );
}

function ShellFrame({ children }: { children: ReactNode }) {
  const { snapshot, fetchedAt, loading, error, stream } = useConsoleData();
  const { theme, dataTheme, cycle } = useConsoleTheme();
  const { dataTextBoxFont } = useConsoleTextBoxFont();
  const { dataConsoleFont } = useConsoleFont();

  if (loading) {
    return (
      <div
        className="console-root flex min-h-dvh items-center justify-center"
        data-theme={dataTheme}
        data-textbox-font={dataTextBoxFont}
        data-console-font={dataConsoleFont}
        suppressHydrationWarning
      >
        <ConsoleIntro />
        <div className="text-center">
          <div className="con-card-title">Socratic Trade</div>
          <p className="mt-2 text-[color:var(--con-muted)]">Loading the autonomy desk…</p>
        </div>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div
        className="console-root flex min-h-dvh items-center justify-center px-6"
        data-theme={dataTheme}
        data-textbox-font={dataTextBoxFont}
        data-console-font={dataConsoleFont}
        suppressHydrationWarning
      >
        <div className="con-card max-w-md p-6 text-center">
          <div className="con-card-title">Socratic Trade</div>
          <p className="mt-2 font-semibold">Couldn&apos;t load the autonomy desk</p>
          <p className="mt-1 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
            {error ?? "The dashboard API did not respond."} The console retries automatically.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="console-root flex min-h-dvh flex-col"
      data-theme={dataTheme}
      data-textbox-font={dataTextBoxFont}
      data-console-font={dataConsoleFont}
      suppressHydrationWarning
    >
      <ConsoleIntro />
      {/* ToastProvider must live INSIDE .console-root: it renders the .con-toasts
          viewport as its last child, and the --con-* design tokens (colors, radii,
          shadows) are scoped to .console-root — a toast mounted outside it would
          render unstyled. The provider adds no DOM around the children, so the
          flex column layout is unchanged; the toasts div is position:fixed. */}
      <SymbolDrawerProvider>
        <ToastProvider>
          {/* Sticky chrome: reality + STOP stay reachable on every screen, especially mobile.
              MobileFreshnessBar lives here (not bottom-anchored) because the fixed bottom tab
              bar (nav.tsx) overlays anything at document end on phones. */}
          <div className="sticky top-0 z-50 bg-[color:var(--con-bg)]">
            <RealityBanner snapshot={snapshot} />
            <ChromeBar snapshot={snapshot} theme={theme} cycleTheme={cycle} />
            <MobileFreshnessBar snapshot={snapshot} fetchedAt={fetchedAt} error={error} stream={stream} />
          </div>
          <div className="mx-auto flex w-full max-w-[1400px] flex-1">
            <DesktopRail pendingCount={snapshot.pendingProposals.length} />
            <main className="min-w-0 flex-1 px-4 pb-24 pt-4 lg:px-6 lg:pb-8">{children}</main>
          </div>
          <FreshnessStrip snapshot={snapshot} fetchedAt={fetchedAt} error={error} stream={stream} />
          <MobileTabBar pendingCount={snapshot.pendingProposals.length} />
          {/* Blocking shared-data-pool consent gate — same semantics as the
              legacy dashboard gate; renders nothing once answered. */}
          <ConsentGate />
          {/* ⌘K / Ctrl+K command palette — from-anywhere jump to any console screen. */}
          <CommandPalette />
        </ToastProvider>
      </SymbolDrawerProvider>
    </div>
  );
}

/** Desktop bar logo: invisible until the intro's candles assemble it (the
 *  splash lands on this exact element), then fades in and stays. Keeps its
 *  layout box while hidden so the splash can measure the landing target and
 *  the bar doesn't shift on reveal. Visible immediately when the intro is
 *  skipped (repeat visit, reduced motion). */
function BrandReveal() {
  const [phase, setPhase] = useState<IntroPhase>(getIntroPhase);
  useEffect(() => {
    setPhase(getIntroPhase()); // catch a phase change between render and subscribe
    return subscribeIntroPhase(setPhase);
  }, []);
  const shown = phase === "landed" || phase === "done";
  return (
    <div
      className="hidden shrink-0 pr-2 lg:block"
      style={{ opacity: shown ? 1 : 0, transition: "opacity .3s ease" }}
      aria-hidden={!shown}
    >
      <HeaderLogo />
    </div>
  );
}

/** Mobile-only intro brand row (the bar logo is display:none below lg). While
 *  the splash plays, the chrome reserves a full-width row above the controls
 *  bar — roughly doubling its height — whose big "SOCRATIC TRADE" is the
 *  splash's landing target. The wordmark stays invisible until the candles
 *  assemble it, holds a beat, then the whole row slides up and away to give
 *  the screen space back. Renders nothing when the intro is skipped. */
const MOBILE_BRAND_HOLD_MS = 3000;
const MOBILE_BRAND_SLIDE_MS = 550;
const WORDMARK_AR = 13.8; // ≈ "SOCRATIC TRADE" aspect ratio (see header-logo.tsx)

function MobileBrandRow() {
  const [state, setState] = useState<"waiting" | "shown" | "leaving" | "gone">(() => {
    const p = getIntroPhase();
    return p === "landed" || p === "done" ? "gone" : "waiting";
  });
  // Two words across most of the width; height follows from the aspect ratio.
  const [logoH, setLogoH] = useState(24);

  useEffect(() => {
    const measure = () => setLogoH(Math.max(16, Math.min(34, Math.round((window.innerWidth * 0.88) / WORDMARK_AR))));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  useEffect(() => {
    let hold = 0, slide = 0, landedHandled = false;
    const apply = (p: IntroPhase) => {
      if (p === "landed" && !landedHandled) {
        landedHandled = true;
        setState("shown");
        hold = window.setTimeout(() => {
          setState("leaving");
          slide = window.setTimeout(() => setState("gone"), MOBILE_BRAND_SLIDE_MS);
        }, MOBILE_BRAND_HOLD_MS);
      } else if (p === "done") {
        // intro skipped without ever landing (repeat visit / reduced motion):
        // drop the row instantly; a post-landing "done" changes nothing.
        setState((s) => (s === "waiting" ? "gone" : s));
      }
    };
    apply(getIntroPhase());
    const un = subscribeIntroPhase(apply);
    return () => { un(); window.clearTimeout(hold); window.clearTimeout(slide); };
  }, []);

  if (state === "gone") return null;
  const rowH = logoH + 20;
  const leaving = state === "leaving";
  return (
    <div
      className="overflow-hidden lg:hidden"
      style={{ height: leaving ? 0 : rowH, transition: `height ${MOBILE_BRAND_SLIDE_MS}ms ease` }}
      aria-hidden={state !== "shown"}
    >
      <div
        className="flex items-center justify-center"
        style={{
          height: rowH,
          opacity: state === "waiting" ? 0 : 1,
          transform: leaving ? "translateY(-100%)" : "translateY(0)",
          transition: `transform ${MOBILE_BRAND_SLIDE_MS}ms ease, opacity .3s ease`
        }}
      >
        <HeaderLogo height={logoH} />
      </div>
    </div>
  );
}

function ChromeBar({
  snapshot,
  theme,
  cycleTheme
}: {
  snapshot: DashboardSnapshot;
  theme: ConsoleTheme;
  cycleTheme: () => void;
}) {
  return (
    <header className="border-b border-[color:var(--con-line)] bg-[color:var(--con-surface)]">
      <MobileBrandRow />
      <div className="mx-auto flex max-w-[1400px] items-center gap-2 px-4 py-2">
        <BrandReveal />
        <ScopeSelector snapshot={snapshot} />
        <StateChip snapshot={snapshot} />
        <div className="flex-1" />
        <div className="hidden md:block">
          <CommandPaletteTrigger />
        </div>
        <ThemeToggle theme={theme} cycle={cycleTheme} />
        <UserMenu snapshot={snapshot} />
        <div className="hidden sm:block">
          <RunOnceButton snapshot={snapshot} />
        </div>
        <RunStateButton snapshot={snapshot} />
      </div>
    </header>
  );
}
