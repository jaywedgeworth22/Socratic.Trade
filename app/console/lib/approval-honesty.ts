/** Client mirrors of the server's approve-time execution-mode resolution and
 *  the honest toast for a finished approve call.  The server uses
 *  `row.executionMode ?? currentMode` (`src/lib/strategy-execution.ts` and
 *  `app/api/proposals/bulk-approve/route.ts`).  A NULL row stamp on a live
 *  account is still a live order. */

import type { ExecutionMode } from "@/lib/types";
import { feedStatusLabel } from "@/lib/dashboard-ui";
import { isSuccessfulApprovalResult } from "./thesis";
import { realityForMode } from "./derive";
import { SENTENCE_GAP } from "./format";

export function resolveApprovalExecutionMode(
  rowMode: ExecutionMode | null | undefined,
  currentMode: ExecutionMode | undefined
): ExecutionMode | undefined {
  return rowMode ?? currentMode;
}

export function willPromptTypedApproval(
  resolvedMode: ExecutionMode | undefined,
  requireTypedConfirmation: boolean | undefined
): boolean {
  return realityForMode(resolvedMode).tone === "live" && requireTypedConfirmation !== false;
}

export type ApprovalHomeToast = {
  tone: "pos" | "warn" | "info";
  title: string;
  detail?: string;
};

/** Home Proposal Details toast.  "Approved" is reserved for a placed/filled/paper
 *  result.  busy/blocked keep the existing card phrases — they are not rewrites. */
export function approvalHomeToast(status: string, reasons?: string[]): ApprovalHomeToast {
  if (isSuccessfulApprovalResult(status)) {
    return { tone: "pos", title: "Approved", detail: `Order status: ${status}` };
  }
  if (status === "blocked") {
    return {
      tone: "warn",
      title: "Blocked at approval time",
      detail: (reasons ?? []).join(" ") || "The policy gate re-ran and refused it."
    };
  }
  if (status === "busy") {
    return {
      tone: "warn",
      title: "Approval is still busy",
      detail:
        (reasons ?? []).join(" ") ||
        `A strategy run is still in progress after waiting.${SENTENCE_GAP}Wait for the run to finish (or for its lock to expire, up to ~5 minutes), then Approve again.`
    };
  }
  return {
    tone: "info",
    title: `Result: ${feedStatusLabel(status)}`,
    detail: (reasons ?? []).join(" ") || undefined
  };
}
