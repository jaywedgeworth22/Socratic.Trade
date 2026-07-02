"use client";

/** Approvals — the decision inbox. One receipt-style card per pending
 *  proposal. Approve/reject hit the real endpoints; LIVE approvals go through
 *  the server's typed-confirmation contract. Also narrates the halted rule:
 *  approvals are refused while the system is stopped. */

import { deriveStateInfo } from "../lib/derive";
import { useConsoleData } from "../lib/useConsoleData";
import { ApprovalCard } from "../components/approval-card";
import { Card, Chip } from "../ui/primitives";

export default function ApprovalsPage() {
  const { snapshot } = useConsoleData();
  if (!snapshot) return null;

  const pending = snapshot.pendingProposals;
  const state = deriveStateInfo(snapshot.policy);
  const stopped = snapshot.policy.systemState === "halted";

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-[length:var(--con-fs-lg)] font-bold">
          Approvals {pending.length > 0 && <span className="con-num text-[color:var(--con-accent)]">({pending.length})</span>}
        </h1>
        <Chip tone={state.tone === "pos" ? "pos" : state.tone === "neg" ? "neg" : "warn"}>{state.label}</Chip>
      </div>

      {stopped && (
        <Card>
          <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-warn)]">
            <strong>The system is stopped.</strong> The server refuses approving or rejecting proposals while stopped —
            start it (or switch to Close-only) from the run-state chip first. Run once can still create proposals.
          </p>
        </Card>
      )}

      {pending.length === 0 ? (
        <Card>
          <div className="py-8 text-center">
            <p className="font-semibold">Nothing is waiting for you.</p>
            <p className="mt-1 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
              When a run proposes a trade, it appears here as a receipt — with the strategist&apos;s reasoning, the
              devil&apos;s-advocate review, and how the idea has moved since. Nothing trades without you while authority
              is Ask-first.
            </p>
          </div>
        </Card>
      ) : (
        pending.map((p) => <ApprovalCard key={p.id} pending={p} />)
      )}

      <p className="text-center text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        Rejections are data, not failures — every idea you pass on keeps being scored, and Results shows how your
        judgment is doing.
      </p>
    </div>
  );
}
