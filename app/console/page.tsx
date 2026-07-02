"use client";

/** Home — "what is my money doing right now?"
 *  Portfolio value + day P&L, daily spend meter, needs-attention inbox,
 *  positions with protection status, and the latest run narrated. */

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { deriveDayPnl, deriveReality, deriveSpend, deriveStateInfo } from "./lib/derive";
import { fmtExact, fmtMoney, fmtMoneyWhole, fmtPct, fmtSignedMoney, timeUntil, EM_DASH } from "./lib/format";
import { useConsoleData } from "./lib/useConsoleData";
import { NeedsAttention } from "./components/needs-attention";
import { PositionsCard } from "./components/positions";
import { RunOnceButton } from "./components/chrome";
import { Ago, Card, Chip, Dash, Meter, SignedText, Stat } from "./ui/primitives";

export default function ConsoleHomePage() {
  const { snapshot } = useConsoleData();
  if (!snapshot) return null;

  const reality = deriveReality(snapshot);
  const state = deriveStateInfo(snapshot.policy);
  const spend = deriveSpend(snapshot);
  const portfolio = snapshot.portfolio;
  const dayPnl = deriveDayPnl(snapshot.performance, reality.mode, portfolio?.totalMarketValue);
  const latest = snapshot.latestStrategyRun;
  const latestRow = snapshot.strategyRuns?.[0];
  const nextRun = snapshot.scheduler?.nextRunAt;

  return (
    <div className="flex flex-col gap-4">
      {/* Money row */}
      <Card>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label={`Portfolio value · ${reality.word}`}
            value={fmtMoney(portfolio?.totalMarketValue)}
            sub={reality.phrase}
          />
          <div>
            <div className="con-card-title">Day P&amp;L</div>
            <div className="con-num mt-1 text-[length:var(--con-fs-xl)] font-semibold leading-tight">
              {dayPnl ? (
                <SignedText value={dayPnl.pnl}>
                  {fmtSignedMoney(dayPnl.pnl)} ({fmtPct(dayPnl.pct, 2, true)})
                </SignedText>
              ) : (
                <Dash />
              )}
            </div>
            <div
              className="mt-0.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]"
              title={dayPnl ? `Baseline: ${fmtMoney(dayPnl.baselineEquity)} at ${fmtExact(dayPnl.baselineAt)}` : undefined}
            >
              {dayPnl ? "vs last snapshot before today" : "no prior-day snapshot yet"}
            </div>
          </div>
          <Stat label="Cash" value={fmtMoney(portfolio?.cash)} sub={`Buying power ${fmtMoney(portfolio?.buyingPower)}`} />
          <div>
            <div className="con-card-title" title="Opening orders only — exits never consume the daily cap.">
              Today the strategy may still spend
            </div>
            <div className="con-num mt-1 text-[length:var(--con-fs-lg)] font-semibold">
              {typeof spend.capNotional === "number"
                ? `${fmtMoneyWhole(Math.max(0, spend.capNotional - spend.usedNotional))} of ${fmtMoneyWhole(spend.capNotional)}`
                : EM_DASH}
            </div>
            <Meter value={spend.usedNotional} max={spend.capNotional} className="mt-2" />
            <div className="mt-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
              {spend.usedOrders} of {spend.capOrders} opening orders used
            </div>
          </div>
        </div>
      </Card>

      <NeedsAttention snapshot={snapshot} />

      <PositionsCard snapshot={snapshot} />

      {/* Latest run */}
      <Card
        title="Latest run"
        action={
          <div className="flex items-center gap-2">
            <div className="sm:hidden">
              <RunOnceButton snapshot={snapshot} size="sm" />
            </div>
            <Link href="/console/activity" className="flex items-center gap-1 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-accent)]">
              Full story <ArrowRight size={12} />
            </Link>
          </div>
        }
      >
        {latest ? (
          <div className="text-[length:var(--con-fs-sm)]">
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone={latest.status === "failed" ? "neg" : "pos"}>{latest.status}</Chip>
              {latestRow && (
                <span className="text-[color:var(--con-faint)]">
                  <Ago iso={latestRow.finishedAt ?? latestRow.startedAt} />
                </span>
              )}
              {latestRow && (
                <span className="con-num text-[color:var(--con-faint)]">
                  {latestRow.proposedCount} proposed · {latestRow.placedCount} placed · {latestRow.paperCount} simulated ·{" "}
                  {latestRow.blockedCount} blocked
                </span>
              )}
            </div>
            <p className="mt-2 leading-relaxed text-[color:var(--con-muted)]">{latest.summary}</p>
            {latest.proposals.length === 0 && latest.status === "completed" && (
              <p className="mt-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                Doing nothing was a decision, not a failure — no candidate cleared the bar this run.
              </p>
            )}
          </div>
        ) : (
          <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
            No runs yet. &ldquo;Run once&rdquo; scans the market and proposes — it always asks first and never places on
            its own.
          </p>
        )}
        <div className="mt-3 border-t border-[color:var(--con-line)] pt-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          {state.state === "active" && nextRun ? (
            <span title={fmtExact(nextRun)}>Next scheduled run {timeUntil(nextRun)} · cadence {snapshot.policy.runCadenceMinutes} min</span>
          ) : (
            <span>
              No scheduled runs — the strategy is {state.label.toLowerCase()}. {state.state === "halted" ? "Start it from the run-state chip above." : ""}
            </span>
          )}
        </div>
      </Card>
    </div>
  );
}
