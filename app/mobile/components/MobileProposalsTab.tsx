"use client";

import type { Dispatch, SetStateAction } from "react";
import { Check, Loader2, X } from "lucide-react";
import type {
  MobileCommandAvailability,
  MobileSnapshot,
  PendingProposal
} from "../mobile-pwa-client";
import {
  MobileProposalReceipt,
  proposalActionFeedback
} from "../mobile-pwa-client";

function money(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

function liveApprovalText(symbol: string): string {
  return `APPROVE LIVE ${symbol.trim().toUpperCase()}`;
}

function orderTypeLabel(value?: string): string {
  if (!value) return "unknown";
  const map: Record<string, string> = {
    market: "Market",
    limit: "Limit",
    stop_market: "Stop-market",
    stop_limit: "Stop-limit"
  };
  return map[value] ?? value.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function executionModeLabel(value?: string): string {
  if (!value) return "mode unknown";
  const map: Record<string, string> = {
    "broker/live": "Live",
    "broker/paper": "Paper"
  };
  return map[value] ?? "mode unknown";
}

function Empty({ label }: { label: string }) {
  return (
    <div className="rounded-md border border-dashed border-line px-3 py-4 text-center text-sm text-faint">
      {label}
    </div>
  );
}

export function MobileProposalsTab({
  snapshot,
  pendingProposals,
  commandAvailability,
  busyKey,
  liveTextByProposal,
  setLiveTextByProposal,
  proposalCommandIds,
  proposalNotices,
  onSubmitCommand
}: {
  snapshot: MobileSnapshot;
  pendingProposals: PendingProposal[];
  commandAvailability: MobileCommandAvailability;
  busyKey: string | null;
  liveTextByProposal: Record<string, string>;
  setLiveTextByProposal: Dispatch<SetStateAction<Record<string, string>>>;
  proposalCommandIds: Record<string, string>;
  proposalNotices: Record<string, { message: string; action: "approve" | "reject" }>;
  onSubmitCommand: (
    commandType: string,
    payload: Record<string, unknown>,
    opts: { key?: string; proposal?: { id: string; action: "approve" | "reject" } }
  ) => Promise<boolean>;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Proposals</h2>
        <span className="text-xs text-faint">{pendingProposals.length}</span>
      </div>

      {pendingProposals.length === 0 ? (
        <Empty label="No pending proposals" />
      ) : (
        pendingProposals.map((proposal) => {
          const live = proposal.executionMode === "broker/live";
          const willPromptTyped = live && snapshot.policy?.requireTypedConfirmation !== false;
          const typedText = liveTextByProposal[proposal.id] ?? "";
          const expectedLiveText = liveApprovalText(proposal.proposal.symbol);
          const livePhraseMatches = !willPromptTyped || typedText.trim().toUpperCase() === expectedLiveText;
          const trackedCommandId = proposalCommandIds[proposal.id];
          const feedback = proposalActionFeedback({
            proposalId: proposal.id,
            busyKey,
            notice: proposalNotices[proposal.id],
            trackedCommand: trackedCommandId
              ? snapshot.recentCommands?.find((command) => command.id === trackedCommandId)
              : undefined
          });
          const actionInFlight = feedback?.phase === "sending" || feedback?.phase === "pending";
          const actionSettled = feedback?.phase === "succeeded";

          return (
            <div key={proposal.id} className="rounded-md border border-line bg-surface p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-base font-semibold">{proposal.proposal.symbol}</p>
                  <p className="text-xs uppercase text-faint">
                    {proposal.proposal.side} · {orderTypeLabel(proposal.proposal.type)} · {executionModeLabel(proposal.executionMode)}
                  </p>
                </div>
                <p className="text-sm font-medium">{money(proposal.estimatedNotional)}</p>
              </div>

              <MobileProposalReceipt pending={proposal} positions={snapshot.positions} />

              {willPromptTyped && (
                <div className="mt-3">
                  <label className="text-xs font-semibold uppercase tracking-wide text-faint" htmlFor={`mobile-live-${proposal.id}`}>
                    Type exactly: <span className="font-mono text-fg">{expectedLiveText}</span>
                  </label>
                  <input
                    id={`mobile-live-${proposal.id}`}
                    className="mt-1 min-h-11 w-full rounded-md border border-line bg-bg px-3 font-mono text-base text-fg outline-none focus:border-accent"
                    placeholder={expectedLiveText}
                    value={typedText}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    onPaste={(event) => event.preventDefault()}
                    onChange={(event) => setLiveTextByProposal((prev) => ({ ...prev, [proposal.id]: event.target.value }))}
                  />
                  <p className="mt-1 text-xs text-faint">
                    Paste is disabled; mobile approvals use the same broker check as console.
                  </p>
                </div>
              )}

              {feedback && (
                <div
                  className={`mt-3 rounded-md border px-3 py-2 text-xs font-medium ${
                    feedback.phase === "failed"
                      ? "border-red-300 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200"
                      : feedback.phase === "succeeded"
                        ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200"
                        : "border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200"
                  }`}
                  role="status"
                >
                  {feedback.phase === "sending" &&
                    (feedback.action === "approve" ? "Sending approve…" : "Sending reject…")}
                  {feedback.phase === "pending" &&
                    `${feedback.action === "approve" ? "Approve" : "Reject"} ${feedback.status}…`}
                  {feedback.phase === "failed" && feedback.message}
                  {feedback.phase === "succeeded" &&
                    (feedback.action === "approve"
                      ? "Approved — waiting for desk refresh."
                      : "Rejected — waiting for desk refresh.")}
                </div>
              )}

              <div className="mt-3 grid grid-cols-2 gap-2">
                <button
                  className="min-h-11 rounded-md bg-emerald-500 px-3 text-sm font-semibold text-black disabled:opacity-50"
                  disabled={!commandAvailability.canSubmitAccountCommand || !livePhraseMatches || actionInFlight || actionSettled}
                  onClick={() =>
                    void onSubmitCommand(
                      "proposal.approve",
                      {
                        proposalId: proposal.id,
                        ...(willPromptTyped
                          ? {
                              liveConfirmation: {
                                proposalId: proposal.id,
                                accountNumber: proposal.accountNumber,
                                executionMode: "broker/live",
                                estimatedNotional: proposal.estimatedNotional ?? null,
                                typedText: typedText.trim().toUpperCase()
                              }
                            }
                          : {})
                      },
                      { key: `proposal.approve:${proposal.id}`, proposal: { id: proposal.id, action: "approve" } }
                    )
                  }
                >
                  {feedback?.action === "approve" && actionInFlight ? (
                    <Loader2 className="mr-1 inline h-4 w-4 animate-spin" />
                  ) : (
                    <Check className="mr-1 inline h-4 w-4" />
                  )}
                  {feedback?.action === "approve" && actionInFlight ? "Approving…" : "Approve"}
                </button>
                <button
                  className="min-h-11 rounded-md border border-line bg-bg px-3 text-sm font-semibold text-fg disabled:opacity-50"
                  disabled={!commandAvailability.canSubmitAccountCommand || actionInFlight || actionSettled}
                  onClick={() =>
                    void onSubmitCommand(
                      "proposal.reject",
                      { proposalId: proposal.id },
                      { key: `proposal.reject:${proposal.id}`, proposal: { id: proposal.id, action: "reject" } }
                    )
                  }
                >
                  {feedback?.action === "reject" && actionInFlight ? (
                    <Loader2 className="mr-1 inline h-4 w-4 animate-spin" />
                  ) : (
                    <X className="mr-1 inline h-4 w-4" />
                  )}
                  {feedback?.action === "reject" && actionInFlight ? "Rejecting…" : "Reject"}
                </button>
              </div>
            </div>
          );
        })
      )}
    </section>
  );
}
