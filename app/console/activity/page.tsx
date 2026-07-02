"use client";

/** Activity — the append-only story: runs (expandable to what each proposed /
 *  blocked, straight from the persisted records), fills, and notification
 *  events, grouped chronologically. Uses only what the snapshot actually
 *  provides — no invented data. */

import { useMemo, useState } from "react";
import type { FillEvent, NotificationEvent, RecentProposal, StrategyRunRow } from "@/lib/types";
import type { UnifiedActivityGroup } from "../../dashboard-types";
import { realityForMode } from "../lib/derive";
import { cx, dayKey, fmtDay, fmtMoney, fmtPct, fmtQty, EM_DASH } from "../lib/format";
import { useConsoleData } from "../lib/useConsoleData";
import { Ago, Card, Chip, Empty, SignedText, type ChipTone } from "../ui/primitives";

type Tab = "all" | "runs" | "fills" | "alerts";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "all", label: "All" },
  { id: "runs", label: "Runs" },
  { id: "fills", label: "Fills" },
  { id: "alerts", label: "Alerts" }
];

export default function ActivityPage() {
  const { snapshot } = useConsoleData();
  const [tab, setTab] = useState<Tab>("all");
  if (!snapshot) return null;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-[length:var(--con-fs-lg)] font-bold">Activity</h1>
        <div className="flex gap-1 rounded-lg border border-[color:var(--con-line)] bg-[color:var(--con-surface)] p-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cx(
                "rounded-md px-3 py-1 text-[length:var(--con-fs-xs)] font-semibold transition-colors",
                tab === t.id
                  ? "bg-[color:var(--con-accent-soft)] text-[color:var(--con-accent)]"
                  : "text-[color:var(--con-muted)] hover:text-[color:var(--con-fg)]"
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === "all" && <UnifiedFeed groups={snapshot.unifiedFeed ?? []} />}
      {tab === "runs" && <RunsList runs={snapshot.strategyRuns ?? []} recentProposals={snapshot.recentProposals ?? []} />}
      {tab === "fills" && <FillsList fills={snapshot.performance?.fills ?? []} />}
      {tab === "alerts" && <AlertsList notifications={snapshot.notifications ?? []} />}
    </div>
  );
}

// ── All (unified feed) ───────────────────────────────────────────────────────

const STATUS_TONE: Record<string, ChipTone> = {
  placed: "pos",
  filled: "pos",
  paper: "pos",
  completed: "pos",
  proposed: "accent",
  pending: "accent",
  blocked: "warn",
  withdrawn: "muted",
  expired: "muted",
  rejected: "muted",
  rejected_by_broker: "neg",
  placing_failed: "neg",
  pending_reconciliation: "warn",
  failed: "neg",
  sent: "pos",
  skipped: "muted"
};

function statusTone(status: string | undefined): ChipTone {
  if (!status) return "muted";
  return STATUS_TONE[status.toLowerCase()] ?? "muted";
}

function DayGroups<T>({
  items,
  timestamp,
  renderItem,
  emptyText
}: {
  items: T[];
  timestamp: (item: T) => string;
  renderItem: (item: T) => React.ReactNode;
  emptyText: string;
}) {
  const groups = useMemo(() => {
    const byDay = new Map<string, T[]>();
    for (const item of items) {
      const key = dayKey(timestamp(item));
      const list = byDay.get(key) ?? [];
      list.push(item);
      byDay.set(key, list);
    }
    return [...byDay.entries()];
  }, [items, timestamp]);

  if (items.length === 0) return <Card><Empty>{emptyText}</Empty></Card>;

  return (
    <div className="flex flex-col gap-4">
      {groups.map(([key, list]) => (
        <div key={key}>
          <div className="con-card-title mb-2 pl-1">{fmtDay(timestamp(list[0]))}</div>
          <div className="flex flex-col gap-2">{list.map(renderItem)}</div>
        </div>
      ))}
    </div>
  );
}

function UnifiedFeed({ groups }: { groups: UnifiedActivityGroup[] }) {
  const sorted = useMemo(
    () => [...groups].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).slice(0, 60),
    [groups]
  );
  return (
    <DayGroups
      items={sorted}
      timestamp={(g) => g.updatedAt}
      emptyText="Nothing has happened yet. Run the strategy once and its story starts here."
      renderItem={(g) => (
        <details key={g.id} className="con-card con-disclosure px-4">
          <summary>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold text-[color:var(--con-fg)]">{g.title}</span>
              <span className="block truncate text-[length:var(--con-fs-xs)] font-normal text-[color:var(--con-faint)]">
                {g.detail}
              </span>
            </span>
            {g.status && <Chip tone={statusTone(g.status)}>{g.status}</Chip>}
            <span className="text-[length:var(--con-fs-xs)] font-normal text-[color:var(--con-faint)]">
              <Ago iso={g.updatedAt} />
            </span>
          </summary>
          <div className="border-t border-[color:var(--con-line)] py-2">
            {g.fullText && <p className="mb-2 text-[length:var(--con-fs-sm)] leading-relaxed text-[color:var(--con-muted)]">{g.fullText}</p>}
            {g.events.length === 0 ? (
              <p className="py-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">No sub-events recorded.</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {g.events.map((e) => (
                  <li key={e.id} className="flex items-start gap-2 text-[length:var(--con-fs-xs)]">
                    <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--con-faint)]" />
                    <span className="min-w-0 flex-1">
                      <span className="font-semibold">{e.title}</span>{" "}
                      <span className="text-[color:var(--con-muted)]">{e.detail}</span>
                      {e.error && <span className="text-[color:var(--con-neg)]"> — {e.error}</span>}
                    </span>
                    <span className="shrink-0 text-[color:var(--con-faint)]">
                      <Ago iso={e.createdAt} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {g.accountLabel && (
              <p className="mt-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">Account: {g.accountLabel}</p>
            )}
          </div>
        </details>
      )}
    />
  );
}

// ── Runs ─────────────────────────────────────────────────────────────────────

function runDuration(run: StrategyRunRow): string {
  if (!run.finishedAt) return EM_DASH;
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return EM_DASH;
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`;
}

const SIDE_LABEL: Record<string, string> = { buy: "BUY", sell: "SELL", short: "SHORT", cover: "COVER" };

function RunsList({ runs, recentProposals }: { runs: StrategyRunRow[]; recentProposals: RecentProposal[] }) {
  const byRun = useMemo(() => {
    const map = new Map<string, RecentProposal[]>();
    for (const p of recentProposals) {
      const list = map.get(p.runId) ?? [];
      list.push(p);
      map.set(p.runId, list);
    }
    return map;
  }, [recentProposals]);

  return (
    <DayGroups
      items={runs}
      timestamp={(r) => r.startedAt}
      emptyText="No strategy runs yet."
      renderItem={(run) => {
        const proposals = byRun.get(run.id) ?? [];
        return (
          <details key={run.id} className="con-card con-disclosure px-4">
            <summary>
              <span className="min-w-0 flex-1">
                <span className="block font-semibold text-[color:var(--con-fg)]">
                  Run · <Ago iso={run.startedAt} /> · {runDuration(run)}
                </span>
                <span className="con-num block text-[length:var(--con-fs-xs)] font-normal text-[color:var(--con-faint)]">
                  {run.proposedCount} proposed · {run.placedCount} placed · {run.paperCount} simulated · {run.blockedCount} blocked
                </span>
              </span>
              <Chip tone={run.status === "failed" ? "neg" : run.status === "running" ? "accent" : "pos"}>{run.status}</Chip>
            </summary>
            <div className="border-t border-[color:var(--con-line)] py-2">
              {run.summary && <p className="mb-2 text-[length:var(--con-fs-sm)] leading-relaxed text-[color:var(--con-muted)]">{run.summary}</p>}
              {run.status === "completed" && run.totalCount === 0 && (
                <p className="mb-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                  Did nothing on purpose — no candidate cleared the bar this run.
                </p>
              )}
              {proposals.length > 0 ? (
                <ul className="flex flex-col gap-2">
                  {proposals.map((p) => {
                    const r = realityForMode(p.executionMode);
                    return (
                      <li key={p.id} className="rounded-lg border border-[color:var(--con-line)] p-2.5 text-[length:var(--con-fs-xs)]">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[length:var(--con-fs-sm)] font-bold">
                            {SIDE_LABEL[p.proposal.side] ?? p.proposal.side} {p.proposal.symbol}
                          </span>
                          <span className="con-num text-[color:var(--con-muted)]">
                            {typeof p.estimatedNotional === "number"
                              ? `~${fmtMoney(p.estimatedNotional)}`
                              : typeof p.proposal.dollarAmount === "number"
                                ? `~${fmtMoney(p.proposal.dollarAmount)}`
                                : typeof p.proposal.quantity === "number"
                                  ? `${fmtQty(p.proposal.quantity)} sh`
                                  : EM_DASH}
                          </span>
                          <Chip tone={statusTone(p.status)}>{p.status}</Chip>
                          <Chip tone={r.tone}>{r.word}</Chip>
                          {typeof p.performanceSinceProposalPct === "number" && (
                            <span title="Side-adjusted move since the proposal's reference price. For a rejected idea this is the counterfactual.">
                              <SignedText value={p.performanceSinceProposalPct}>
                                since: {fmtPct(p.performanceSinceProposalPct, 2, true)}
                              </SignedText>
                            </span>
                          )}
                        </div>
                        <p className="mt-1 leading-relaxed text-[color:var(--con-muted)]">{p.proposal.rationale}</p>
                        {p.decision.reasons.length > 0 && (
                          <ul className="mt-1 list-disc pl-4 text-[color:var(--con-warn)]">
                            {p.decision.reasons.map((reason, i) => (
                              <li key={i}>{reason}</li>
                            ))}
                          </ul>
                        )}
                        {p.errorMessage && <p className="mt-1 text-[color:var(--con-neg)]">{p.errorMessage}</p>}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                  No per-proposal records retained for this run.
                </p>
              )}
            </div>
          </details>
        );
      }}
    />
  );
}

// ── Fills ────────────────────────────────────────────────────────────────────

function FillsList({ fills }: { fills: FillEvent[] }) {
  const sorted = useMemo(
    () => [...fills].sort((a, b) => new Date(b.filledAt).getTime() - new Date(a.filledAt).getTime()).slice(0, 100),
    [fills]
  );
  return (
    <DayGroups
      items={sorted}
      timestamp={(f) => f.filledAt}
      emptyText="No fills yet."
      renderItem={(f) => {
        const r = realityForMode(f.executionMode ?? (f.source === "live" ? "broker/live" : undefined));
        return (
          <div key={f.id} className="con-card flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[length:var(--con-fs-sm)]">
            <span className="font-bold">
              {SIDE_LABEL[f.side] ?? f.side} {f.symbol}
            </span>
            <span className="con-num text-[color:var(--con-muted)]">
              {fmtQty(f.quantity)} @ {fmtMoney(f.price)} = {fmtMoney(f.notional)}
            </span>
            <Chip tone={r.tone} title={r.clarification}>
              {r.word}
            </Chip>
            {f.status !== "filled" && (
              <Chip tone={statusTone(f.status)} title="Recorded intent awaiting broker-truth reconciliation — it cannot double-place.">
                {f.status}
              </Chip>
            )}
            <span className="ml-auto text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
              <Ago iso={f.filledAt} />
            </span>
          </div>
        );
      }}
    />
  );
}

// ── Alerts / notifications ───────────────────────────────────────────────────

function AlertsList({ notifications }: { notifications: NotificationEvent[] }) {
  const sorted = useMemo(
    () => [...notifications].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 100),
    [notifications]
  );
  return (
    <DayGroups
      items={sorted}
      timestamp={(n) => n.createdAt}
      emptyText="No notification events yet."
      renderItem={(n) => (
        <div key={n.id} className="con-card flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[length:var(--con-fs-sm)]">
          <Chip tone={n.type === "kill_switch" ? "neg" : n.type === "pending_approval" ? "accent" : "muted"}>{n.type}</Chip>
          <span className="min-w-0 flex-1 truncate font-semibold">{n.title}</span>
          <Chip tone={statusTone(n.status)} title={n.error ?? undefined}>
            {n.status}
          </Chip>
          <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            <Ago iso={n.createdAt} />
          </span>
        </div>
      )}
    />
  );
}
