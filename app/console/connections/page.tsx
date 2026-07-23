"use client";

/** Connections — the one-time-setup half of the old Settings page, split out
 *  in the 2026-07-16 Configure IA restructure: broker accounts and provider
 *  API keys, both user-level (ALL YOUR ACCOUNTS — they overlay every account
 *  you connect). Recurring preferences (notifications, sharing, appearance,
 *  etc.) stay on Settings. The card modules themselves did not move — they
 *  still live in ../settings/brokers and ../settings/api-keys, imported from
 *  here, so their fetch helpers in ../settings/lib keep working unchanged. */

import { useEffect } from "react";
import { CONSOLE_PAGE_WIDTH } from "../lib/page-width";
import { useConsoleData } from "../lib/useConsoleData";
import { Chip } from "../ui/primitives";
import { ApiKeysCard } from "../settings/api-keys";
import { BrokerAccountsCard } from "../settings/brokers";

export default function ConnectionsPage() {
  const { snapshot } = useConsoleData();
  const ready = snapshot !== null;

  // Deep links (e.g. the Run-once blocked sheet, the account-scope menu, and the
  // Robinhood OAuth return trip all route to /console/connections#brokers or
  // #api-keys): the page renders only after the snapshot arrives, so the native
  // anchor jump misses — scroll once the target section actually exists.
  useEffect(() => {
    if (!ready || typeof window === "undefined") return;
    const hash = window.location.hash.slice(1);
    if (!hash) return;
    const timer = setTimeout(() => document.getElementById(hash)?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
    return () => clearTimeout(timer);
  }, [ready]);

  if (!snapshot) return null;

  return (
    <div className={`${CONSOLE_PAGE_WIDTH} flex flex-col gap-6`}>
      <h1 className="px-4 text-[length:var(--con-fs-lg)] font-bold lg:px-0">Connections</h1>

      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Chip
            tone="accent"
            title="Settings tagged ALL YOUR ACCOUNTS are stored per user — they overlay every account you connect, in every scope."
          >
            ALL YOUR ACCOUNTS
          </Chip>
          <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            applies everywhere, for you
          </span>
        </div>
        {/* Anchor ids (#brokers/#api-keys) are deep-link targets used by the
            Run-once blocked-reason sheet, the account-scope menu, and the
            Robinhood OAuth return trip; scroll-mt clears the sticky chrome. */}
        <div id="brokers" className="scroll-mt-28">
          <BrokerAccountsCard />
        </div>
        <div id="api-keys" className="scroll-mt-28">
          <ApiKeysCard />
        </div>
      </section>
    </div>
  );
}
