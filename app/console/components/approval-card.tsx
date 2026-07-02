"use client";

/** Receipt-style approval cards. Each pending proposal renders as a decision
 *  receipt: what/how much, the thesis + confidence, the adversarial (red team)
 *  verdict, what has happened since it was proposed, the policy-gate status,
 *  and an honest three-outcomes block. Approvals on LIVE money go through the
 *  server's typed-confirmation contract (LIVE_CONFIRMATION_REQUIRED). */

import { useMemo, useState } from "react";
import { ShieldCheck, Swords } from "lucide-react";
import type { PendingProposal, TradingPolicy } from "@/lib/types";
import {
  approveProposal,
  rejectProposal,
  ConsoleApiError,
  LiveConfirmationRequiredError,
  type ApproveResult
} from "../lib/api";
import { realityForMode } from "../lib/derive";
import { cx, fmtMoney, fmtPct, fmtQty, timeUntil, EM_DASH } from "../lib/format";
import { useConsoleData } from "../lib/useConsoleData";
import { useToast } from "../ui/toast";
import { Ago, Btn, Chip, Dash, SignedText, TextInput } from "../ui/primitives";
import { Sheet } from "../ui/sheet";

const SIDE_LABEL: Record<string, string> = { buy: "BUY", sell: "SELL", short: "SHORT", cover: "COVER" };

function isExit(side: string): boolean {
  return side === "sell" || side === "cover";
}

function estNotional(p: PendingProposal): number | undefined {
  const v = p.estimatedNotional ?? p.review?.estimatedNotional ?? p.proposal.dollarAmount;
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function expiryIso(p: PendingProposal, policy: TradingPolicy): string | null {
  const minutes = policy.proposalExpiryMinutes;
  if (!minutes || minutes <= 0) return null;
  const t = new Date(p.createdAt).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t + minutes * 60_000).toISOString();
}

export function ApprovalCard({ pending }: { pending: PendingProposal }) {
  const { snapshot, refresh } = useConsoleData();
  const toast = useToast();
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [liveOpen, setLiveOpen] = useState(false);

  const p = pending.proposal;
  const reality = realityForMode(pending.executionMode);
  const live = reality.tone === "live";
  const notional = estNotional(pending);
  const expiresAt = snapshot ? expiryIso(pending, snapshot.policy) : null;
  const sizeText =
    typeof p.dollarAmount === "number"
      ? `~${fmtMoney(p.dollarAmount)}`
      : typeof p.quantity === "number"
        ? `${fmtQty(p.quantity)} sh`
        : EM_DASH;

  const finish = (result: ApproveResult) => {
    if (result.status === "placed") {
      toast.push("pos", `${SIDE_LABEL[p.side] ?? p.side} ${p.symbol} placed`, "The order went to the broker with a durable, idempotent intent record.");
    } else if (result.status === "paper") {
      toast.push("pos", `${SIDE_LABEL[p.side] ?? p.side} ${p.symbol} filled (simulated)`, "Recorded as a practice-money fill.");
    } else if (result.status === "blocked") {
      toast.push("warn", "Blocked at approval time", (result.reasons ?? []).join(" ") || "The policy gate re-ran and refused it.");
    } else {
      toast.push("info", `Result: ${result.status}`, (result.reasons ?? []).join(" ") || undefined);
    }
  };

  const approve = async () => {
    if (live) {
      setLiveOpen(true);
      return;
    }
    setBusy("approve");
    try {
      const result = await approveProposal(pending.id);
      await refresh();
      finish(result);
    } catch (error) {
      toast.push("neg", "Approval failed", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const reject = async () => {
    setBusy("reject");
    try {
      await rejectProposal(pending.id);
      await refresh();
      toast.push("info", `Rejected ${p.symbol}`, "The idea keeps being scored — you'll see how it does after you passed.");
    } catch (error) {
      toast.push("neg", "Rejection failed", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className={cx("con-card overflow-hidden", live && "border-[color:rgba(255,93,93,0.5)]")}>
      {/* Header: verb + symbol + reality word */}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-[color:var(--con-line)] px-4 py-3">
        <span className={cx("text-[length:var(--con-fs-md)] font-bold", isExit(p.side) ? "text-[color:var(--con-warn)]" : undefined)}>
          {SIDE_LABEL[p.side] ?? p.side.toUpperCase()} {p.symbol}
        </span>
        <span className="con-num text-[length:var(--con-fs-md)] font-semibold">{sizeText}</span>
        {isExit(p.side) && (
          <Chip tone="warn" title="Risk-reducing exits are never trapped by caps or universe rules.">
            <ShieldCheck size={11} /> risk-reducing
          </Chip>
        )}
        <div className="flex-1" />
        <Chip tone={reality.tone} title={reality.clarification}>
          {reality.word} · {reality.phrase}
        </Chip>
      </header>

      <div className="flex flex-col gap-3 px-4 py-3 text-[length:var(--con-fs-sm)]">
        {/* Thesis line */}
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone="accent">{p.tradeThesisTag}</Chip>
          {typeof p.confidenceScore === "number" && <span className="con-num text-[color:var(--con-muted)]">Confidence {p.confidenceScore}/100</span>}
          <span className="text-[color:var(--con-faint)]">Regime at proposal: {p.entryMarketRegime || EM_DASH}</span>
          <span className="text-[color:var(--con-faint)]">
            Proposed <Ago iso={pending.createdAt} />
          </span>
        </div>

        {/* Why */}
        <div>
          <div className="con-card-title mb-1">Why (the strategist)</div>
          <p className="leading-relaxed text-[color:var(--con-muted)]">{p.rationale}</p>
        </div>

        {/* Red team */}
        {p.redTeamVerdict?.available && (
          <div className="rounded-lg border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] p-3">
            <div className="con-card-title mb-1 flex items-center gap-1.5">
              <Swords size={12} /> Devil&apos;s advocate
            </div>
            <p className="leading-relaxed text-[color:var(--con-muted)]">{p.redTeamVerdict.reason}</p>
            <p className="mt-1 text-[length:var(--con-fs-xs)] font-semibold" style={{ color: p.redTeamVerdict.rejected ? "var(--con-neg)" : "var(--con-pos)" }}>
              {p.redTeamVerdict.rejected ? "Verdict: rejected" : "Verdict: survived review"}
            </p>
          </div>
        )}

        {/* Since proposed + revalidation */}
        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <div className="con-card-title mb-1">Since proposed</div>
            {typeof pending.performanceSinceProposalPct === "number" ? (
              <p>
                <SignedText value={pending.performanceSinceProposalPct}>{fmtPct(pending.performanceSinceProposalPct, 2, true)}</SignedText>{" "}
                <span className="text-[color:var(--con-faint)]">
                  in the proposed direction
                  {typeof pending.proposalReferencePrice === "number" && typeof pending.proposalCurrentPrice === "number"
                    ? ` (${fmtMoney(pending.proposalReferencePrice)} → ${fmtMoney(pending.proposalCurrentPrice)})`
                    : ""}
                </span>
              </p>
            ) : (
              <Dash />
            )}
          </div>
          <div>
            <div className="con-card-title mb-1">Last re-check</div>
            {pending.revalidationNote ? (
              <p className="text-[color:var(--con-muted)]">
                &ldquo;{pending.revalidationNote}&rdquo;{" "}
                <span className="text-[color:var(--con-faint)]">
                  <Ago iso={pending.lastRevalidatedAt} />
                </span>
              </p>
            ) : (
              <p className="text-[color:var(--con-faint)]">Not re-validated yet — the next run re-checks it.</p>
            )}
          </div>
        </div>

        {/* Gate status */}
        <div>
          <div className="con-card-title mb-1">Policy gate</div>
          {pending.decision.reasons.length > 0 ? (
            <ul className="list-disc pl-4 text-[color:var(--con-muted)]">
              {pending.decision.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          ) : (
            <p className="text-[color:var(--con-muted)]">
              Passed every check when proposed. The full gate re-runs server-side at the moment you approve — with fresh
              prices, caps, and wash-sale state.
            </p>
          )}
        </div>

        {/* Three outcomes */}
        <div className="rounded-lg border border-[color:var(--con-line)] p-3 text-[length:var(--con-fs-xs)] leading-relaxed">
          <p>
            <strong>If you approve:</strong> {SIDE_LABEL[p.side]?.toLowerCase() ?? p.side} {sizeText} at {p.type.replace("_", " ")}
            {typeof p.limitPrice === "number" ? ` (limit ${fmtMoney(p.limitPrice)})` : ""}.
            {typeof p.bracketStopLoss === "number" || typeof p.bracketTakeProfit === "number" ? (
              <>
                {" "}
                Bracket protection: {typeof p.bracketStopLoss === "number" ? `stop ${fmtMoney(p.bracketStopLoss)}` : ""}
                {typeof p.bracketStopLoss === "number" && typeof p.bracketTakeProfit === "number" ? " · " : ""}
                {typeof p.bracketTakeProfit === "number" ? `take-profit ${fmtMoney(p.bracketTakeProfit)}` : ""}.
              </>
            ) : null}
            {live ? " This spends real money and requires typing the approval phrase." : ""}
          </p>
          <p className="mt-1">
            <strong>If you reject:</strong> nothing is traded. The idea stays on the record and its counterfactual return
            keeps being measured.
          </p>
          <p className="mt-1">
            <strong>If you do nothing:</strong>{" "}
            {expiresAt ? (
              <>
                it expires {timeUntil(expiresAt)} and nothing is traded.
              </>
            ) : (
              "it stays pending until a run withdraws it or you decide."
            )}
          </p>
        </div>
      </div>

      {/* Actions */}
      <footer className="flex items-center justify-end gap-2 border-t border-[color:var(--con-line)] px-4 py-3">
        <Btn variant="ghost" disabled={busy !== null} onClick={() => void reject()}>
          {busy === "reject" ? "Rejecting…" : "Reject"}
        </Btn>
        <Btn variant={live ? "danger" : "pos"} disabled={busy !== null} onClick={() => void approve()}>
          {busy === "approve" ? "Approving…" : live ? "Approve with real money…" : "Approve"}
        </Btn>
      </footer>

      {live && (
        <LiveApproveSheet
          open={liveOpen}
          onClose={() => setLiveOpen(false)}
          pending={pending}
          notional={notional}
          onDone={finish}
        />
      )}
    </article>
  );
}

/** The typed real-money confirmation. The server contract
 *  (assertLiveApprovalConfirmation) verifies: proposal id, account number,
 *  executionMode "broker/live", the reviewed estimated notional (±$0.01), and
 *  the exact phrase APPROVE LIVE <SYMBOL>. On mismatch the server answers 409
 *  with its reasons and the authoritative expected text — rendered verbatim. */
function LiveApproveSheet({
  open,
  onClose,
  pending,
  notional,
  onDone
}: {
  open: boolean;
  onClose: () => void;
  pending: PendingProposal;
  notional: number | undefined;
  onDone: (result: ApproveResult) => void;
}) {
  const { refresh } = useConsoleData();
  const toast = useToast();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [serverReasons, setServerReasons] = useState<string[]>([]);
  const [serverExpected, setServerExpected] = useState<string | null>(null);

  const expectedText = useMemo(
    () => serverExpected ?? `APPROVE LIVE ${pending.proposal.symbol.toUpperCase()}`,
    [serverExpected, pending.proposal.symbol]
  );
  const matches = typed.trim().toUpperCase() === expectedText;

  const submit = async () => {
    setBusy(true);
    try {
      const result = await approveProposal(pending.id, {
        proposalId: pending.id,
        accountNumber: pending.accountNumber ?? null,
        executionMode: "broker/live",
        estimatedNotional: notional ?? null,
        typedText: typed.trim().toUpperCase()
      });
      await refresh();
      onClose();
      setTyped("");
      setServerReasons([]);
      onDone(result);
    } catch (error) {
      if (error instanceof LiveConfirmationRequiredError) {
        // The server is the authority: show its reasons and its expected text.
        setServerReasons(error.reasons);
        setServerExpected(error.expectedText);
        setTyped("");
      } else {
        toast.push("neg", "Live approval failed", error instanceof ConsoleApiError ? error.message : String(error));
        onClose();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Real-money approval" tone="live">
      <div className="mb-3 rounded-lg border border-[color:rgba(255,93,93,0.45)] bg-[color:var(--con-live-soft)] p-3 text-[length:var(--con-fs-sm)]">
        <div className="font-bold text-[color:var(--con-live)]">LIVE · real money</div>
        <p className="con-num mt-1">
          {SIDE_LABEL[pending.proposal.side] ?? pending.proposal.side.toUpperCase()} {pending.proposal.symbol} — estimated{" "}
          <strong>{fmtMoney(notional)}</strong>
          {pending.accountNumber ? ` from account ·· ${pending.accountNumber.slice(-4)}` : ""}
        </p>
        <p className="mt-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
          The server re-checks everything at this moment — fresh price, entry drift, caps, wash-sale locks. If anything no
          longer passes, nothing is placed and you&apos;ll see the reasons here.
        </p>
      </div>

      {serverReasons.length > 0 && (
        <div className="mb-3 rounded-lg border border-[color:rgba(229,170,75,0.5)] p-3 text-[length:var(--con-fs-xs)]">
          <div className="font-semibold text-[color:var(--con-warn)]">The server refused the confirmation:</div>
          <ul className="mt-1 list-disc pl-4 text-[color:var(--con-muted)]">
            {serverReasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      <label className="con-label" htmlFor={`live-typed-${pending.id}`}>
        Type exactly: <span className="con-mono text-[color:var(--con-fg)]">{expectedText}</span>
      </label>
      <TextInput
        id={`live-typed-${pending.id}`}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="characters"
        spellCheck={false}
        onPaste={(e) => e.preventDefault()}
        placeholder={expectedText}
        className="con-mono"
      />
      <p className="mt-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">Paste is disabled on purpose — the words are the consent.</p>

      <div className="mt-4 flex justify-end gap-2">
        <Btn variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Btn>
        <Btn variant="danger" disabled={!matches || busy} onClick={() => void submit()}>
          {busy ? "Placing…" : "Place real order"}
        </Btn>
      </div>
    </Sheet>
  );
}
