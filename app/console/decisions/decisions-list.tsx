import Link from "next/link";
import type { SocraticDecisionCase } from "@/lib/types";
import { fmtExact, timeAgo } from "../lib/format";
import { decisionStatusLabel, thesisTagLabel } from "../lib/labels";
import { Card, Chip, Empty } from "../ui/primitives";

const SIDE_LABEL: Record<string, string> = { buy: "BUY", sell: "SELL", short: "SHORT", cover: "COVER" };

/** Tone mirrors the decision lifecycle: placed/filled positive, blocked/rejected
 *  negative, everything in-flight neutral. Words carry the meaning either way. */
function statusTone(status: SocraticDecisionCase["status"]): "pos" | "neg" | "muted" {
  if (status === "placed" || status === "filled") return "pos";
  if (status === "blocked" || status === "rejected" || status === "rejected_by_broker") return "neg";
  return "muted";
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
                  title={fmtExact(decision.createdAt)}
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
