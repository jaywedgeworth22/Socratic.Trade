"use client";

/** All-decisions index — the landing page for the console Home "All Decisions"
 *  link (this route 404'd before; issue #2556). A simple reverse-chron list of
 *  recent Socratic decision cases (symbol, side, thesis tag, status, age), each
 *  row linking into its full trace at /console/decisions/[id]. Data comes from
 *  the same API the trace page uses (/api/socratic/decisions, already
 *  reverse-chron by created_at); this page owns its own loading/error state
 *  like the [id] page does. */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Brain } from "lucide-react";
import type { SocraticDecisionCase } from "@/lib/types";
import { timeAgo } from "../lib/format";
import { decisionStatusLabel, thesisTagLabel } from "../lib/labels";
import { CONSOLE_PAGE_WIDTH } from "../lib/page-width";
import { Card, Chip, Empty } from "../ui/primitives";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; decisions: SocraticDecisionCase[] };

const SIDE_LABEL: Record<string, string> = { buy: "BUY", sell: "SELL", short: "SHORT", cover: "COVER" };

/** Tone mirrors the decision lifecycle: placed/filled positive, blocked/rejected
 *  negative, everything in-flight neutral. Words carry the meaning either way. */
function statusTone(status: SocraticDecisionCase["status"]): "pos" | "neg" | "muted" {
  if (status === "placed" || status === "filled") return "pos";
  if (status === "blocked" || status === "rejected" || status === "rejected_by_broker") return "neg";
  return "muted";
}

export default function DecisionsIndexPage() {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/socratic/decisions?limit=100", { cache: "no-store" });
      if (!response.ok) throw new Error(await response.text());
      const decisions = (await response.json()) as SocraticDecisionCase[];
      setState({ status: "ready", decisions });
    } catch (error) {
      setState({ status: "error", message: error instanceof Error ? error.message : "Could not load decisions." });
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  return (
    <div className={`${CONSOLE_PAGE_WIDTH} flex flex-col gap-4`}>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="flex items-center gap-2 text-[length:var(--con-fs-lg)] font-bold">
          <Brain size={16} /> Decisions
        </h1>
        {state.status === "ready" && (
          <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            {state.decisions.length} recent decision {state.decisions.length === 1 ? "case" : "cases"}, newest first
          </span>
        )}
      </div>

      {state.status === "loading" && (
        <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">Loading decisions…</p>
      )}

      {state.status === "error" && (
        <Card>
          <p className="text-[color:var(--con-warn)]">{state.message}</p>
        </Card>
      )}

      {state.status === "ready" && <DecisionsList decisions={state.decisions} />}
    </div>
  );
}

/** Pure list body — exported for the route smoke test (no fetch, no hooks). */
export function DecisionsList({ decisions }: { decisions: SocraticDecisionCase[] }) {
  return (
    <Card padded={false}>
      {decisions.length === 0 ? (
        <Empty>No decision traces yet.</Empty>
      ) : (
        <div className="flex flex-col divide-y divide-[color:var(--con-line)]">
          {decisions.map((decision) => (
            <Link
              key={decision.id}
              href={`/console/decisions/${encodeURIComponent(decision.id)}`}
              className="flex items-start justify-between gap-3 px-4 py-3 transition-colors hover:bg-[color:var(--con-surface-2)]"
            >
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[length:var(--con-fs-sm)] font-semibold">
                    {decision.symbol ?? "Portfolio"}
                  </span>
                  {decision.side && (
                    <span className="text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-muted)]">
                      {SIDE_LABEL[decision.side] ?? decision.side.toUpperCase()}
                    </span>
                  )}
                  {decision.thesisTag && <Chip tone="muted">{thesisTagLabel(decision.thesisTag)}</Chip>}
                </span>
                {decision.thesis && (
                  <span className="mt-0.5 block truncate text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                    {decision.thesis}
                  </span>
                )}
              </span>
              <span className="flex shrink-0 flex-col items-end gap-1">
                <Chip tone={statusTone(decision.status)}>{decisionStatusLabel(decision.status)}</Chip>
                <span
                  className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]"
                  title={new Date(decision.createdAt).toLocaleString()}
                >
                  {timeAgo(decision.createdAt)}
                </span>
              </span>
            </Link>
          ))}
        </div>
      )}
    </Card>
  );
}
