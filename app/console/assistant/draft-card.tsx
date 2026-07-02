"use client";

/** A trade draft the assistant produced, rendered as a compact order ticket.
 *
 *  Improved handoff vs the legacy assistant: the policy dry-run preview runs
 *  automatically when the ticket appears (no extra click), and staging hands
 *  off to the console's Approvals screen — the one decision surface — instead
 *  of duplicating an approve/reject rail inside chat. The dry-run is a PREVIEW:
 *  the authoritative policy check re-runs at approval time (and a block that is
 *  staleness-only still stages — the server folds that into its decision). */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ArrowRight, Check, Loader2, RefreshCw, ShieldCheck, X } from "lucide-react";
import type { ChatDraft } from "@/lib/chat/types";
import type { RealityInfo } from "../lib/derive";
import { fmtMoney } from "../lib/format";
import { useConsoleData } from "../lib/useConsoleData";
import { Btn, Chip } from "../ui/primitives";
import { useToast } from "../ui/toast";

interface Decision {
  approved: boolean;
  reasons: string[];
}

type Phase = "checking" | "ready" | "staging" | "staged" | "discarded";

async function readBody(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

function reasonsFrom(body: Record<string, unknown>, fallback: string): string[] {
  if (Array.isArray(body.reasons) && body.reasons.length > 0) return body.reasons.map(String);
  if (typeof body.error === "string" && body.error) return [body.error];
  return [fallback];
}

export function DraftTicket({ draft, reality }: { draft: ChatDraft; reality: RealityInfo }) {
  const { refresh } = useConsoleData();
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>("checking");
  const [decision, setDecision] = useState<Decision | null>(null);
  const [estimatedNotional, setEstimatedNotional] = useState<number | undefined>(undefined);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [proposalId, setProposalId] = useState<string | null>(null);

  const runPreview = useCallback(async () => {
    setPhase("checking");
    setPreviewError(null);
    try {
      const res = await fetch("/api/proposals/from-draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draft, dryRun: true })
      });
      const body = await readBody(res);
      if (!res.ok) {
        setDecision({ approved: false, reasons: reasonsFrom(body, `Policy preview failed (${res.status}).`) });
        setEstimatedNotional(undefined);
      } else {
        const d = body.decision as Decision | undefined;
        setDecision(d && typeof d.approved === "boolean" ? d : null);
        setEstimatedNotional(typeof body.estimatedNotional === "number" ? body.estimatedNotional : undefined);
      }
    } catch {
      // Network failure of the PREVIEW only — staging stays available because the
      // server re-checks policy authoritatively on commit and again at approval.
      setDecision(null);
      setPreviewError("Policy preview unreachable right now. You can still stage — the server re-checks before anything is created.");
    }
    setPhase("ready");
  }, [draft]);

  useEffect(() => {
    void runPreview();
  }, [runPreview]);

  const stage = async () => {
    setPhase("staging");
    try {
      const res = await fetch("/api/proposals/from-draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draft })
      });
      const body = await readBody(res);
      if (res.ok && typeof body.proposalId === "string") {
        setProposalId(body.proposalId);
        if (typeof body.estimatedNotional === "number") setEstimatedNotional(body.estimatedNotional);
        setPhase("staged");
        toast.push(
          "pos",
          body.deduped ? "Already staged" : "Staged for approval",
          "Review it in Approvals — nothing places until you approve it there."
        );
        void refresh(); // bump the Approvals badge right away
        return;
      }
      const reasons = reasonsFrom(body, `Could not stage (${res.status}).`);
      setDecision({ approved: false, reasons });
      setPhase("ready");
      toast.push("warn", "Blocked by policy", reasons.join(" "));
    } catch (e) {
      setPhase("ready");
      toast.push("neg", "Staging failed", e instanceof Error ? e.message : "Network error — try again.");
    }
  };

  if (phase === "discarded") {
    return (
      <div className="mt-2 rounded-lg border border-[color:var(--con-line)] bg-[color:var(--con-surface)] px-3 py-1.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
        Draft discarded. Nothing was created.
      </div>
    );
  }

  const sideUp = draft.side.toUpperCase();
  const orderLine = `${sideUp} ${draft.qty} ${draft.symbol} · ${draft.order_type}${
    draft.order_type === "limit" && draft.limit_usd != null ? ` @ ${fmtMoney(draft.limit_usd)}` : ""
  }`;
  const blocked = decision !== null && !decision.approved;
  const live = reality.tone === "live";

  return (
    <div className="mt-2 rounded-lg border border-[color:var(--con-line-strong)] bg-[color:var(--con-surface)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="con-mono text-[length:var(--con-fs-sm)] font-semibold" title="The order the assistant drafted. It is only a draft until you stage and then approve it.">
          {orderLine}
        </span>
        <Chip tone={reality.tone} title={reality.clarification}>
          {reality.word} · {reality.phrase}
        </Chip>
      </div>
      {draft.rationale && <p className="mt-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">{draft.rationale}</p>}
      {draft.warnings.length > 0 && (
        <ul
          className="mt-1.5 space-y-0.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-warn)]"
          title="Cautions the assistant itself attached to this draft."
        >
          {draft.warnings.map((w, i) => (
            <li key={i}>⚠ {w}</li>
          ))}
        </ul>
      )}

      {/* Policy preview result */}
      {phase === "checking" && (
        <div className="mt-2 flex items-center gap-1.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
          <Loader2 size={13} className="animate-spin" /> Checking against your guardrails…
        </div>
      )}
      {phase !== "checking" && decision && (
        <div
          className="mt-2 rounded-md px-2.5 py-1.5 text-[length:var(--con-fs-xs)]"
          style={{
            background: blocked ? "var(--con-neg-soft)" : "var(--con-pos-soft)",
            color: blocked ? "var(--con-neg)" : "var(--con-pos)"
          }}
          title={
            blocked
              ? "Your policy guardrails would refuse this order as things stand now."
              : "A preview check against your policy guardrails. The authoritative check re-runs when you approve."
          }
        >
          <div className="flex flex-wrap items-center gap-1.5 font-semibold">
            {blocked ? <AlertTriangle size={13} /> : <ShieldCheck size={13} />}
            {blocked ? "Blocked by policy" : "Passes policy preview"}
            {estimatedNotional !== undefined && (
              <span
                className="con-num font-normal text-[color:var(--con-muted)]"
                title="Estimated order value from the broker's pre-trade review. Final numbers are re-checked at approval time."
              >
                · est. {fmtMoney(estimatedNotional)}
              </span>
            )}
          </div>
          {blocked && decision.reasons.length > 0 && (
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {decision.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {phase !== "checking" && previewError && (
        <div
          className="mt-2 rounded-md bg-[color:var(--con-warn-soft)] px-2.5 py-1.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-warn)]"
          title="Only the preview failed. Staging still runs the real policy check on the server."
        >
          <AlertTriangle size={13} className="mr-1.5 inline-block align-[-2px]" />
          {previewError}
        </div>
      )}

      {/* Actions */}
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {phase === "ready" && !blocked && (
          <Btn
            size="sm"
            variant="primary"
            onClick={() => void stage()}
            title="Creates a pending proposal in Approvals. Nothing is bought or sold until you approve it there."
          >
            Stage for approval <ArrowRight size={13} />
          </Btn>
        )}
        {phase === "staging" && (
          <span className="flex items-center gap-1.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
            <Loader2 size={13} className="animate-spin" /> Staging…
          </span>
        )}
        {phase === "ready" && (
          <Btn
            size="sm"
            variant="ghost"
            onClick={() => void runPreview()}
            title="Run the policy preview again — guardrails, account state, or prices may have changed."
          >
            <RefreshCw size={13} /> Re-check
          </Btn>
        )}
        {(phase === "ready" || phase === "staging") && (
          <Btn
            size="sm"
            variant="ghost"
            disabled={phase === "staging"}
            onClick={() => setPhase("discarded")}
            title="Dismiss this draft. It only removes the card — nothing was created yet."
          >
            <X size={13} /> Discard
          </Btn>
        )}
        {phase === "staged" && proposalId && (
          <>
            <span className="flex items-center gap-1.5 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-pos)]">
              <Check size={13} /> Staged for approval
            </span>
            <Link
              href="/console/approvals"
              className="con-btn con-btn-outline con-btn-sm"
              title={
                live
                  ? "Open the Approvals screen. Approving there places a REAL order with real money."
                  : "Open the Approvals screen to approve or reject this proposal."
              }
            >
              Review in Approvals <ArrowRight size={13} />
            </Link>
            <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
              {live ? "Approving there places a real-money order." : "Nothing places until you approve it there."}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
