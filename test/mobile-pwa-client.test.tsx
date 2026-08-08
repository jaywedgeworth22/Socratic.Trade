import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commandLabel,
  createCoalescedMobileSnapshotLoader,
  getMobileCommandAvailability,
  mobileRunState,
  MobileSnapshotUnavailable,
  nextDraftAfterCommandAcceptance,
  proposalActionFeedback,
  requestMobileSnapshot,
  strategyAuthorityLabel,
  type MobileSnapshot
} from "../app/mobile/mobile-pwa-client";

afterEach(() => vi.useRealTimers());

function mobileSnapshot(overrides: Partial<MobileSnapshot["readiness"]> = {}): MobileSnapshot {
  return {
    readiness: {
      hasAccount: true,
      hasUniverse: true,
      systemState: "halted",
      strategyAuthority: "propose",
      selectedAccountNumber: "PAPER-1",
      commandBacklog: { queued: 0, running: 0 },
      ...overrides
    },
    policy: {
      systemState: "halted",
      strategyAuthority: "propose"
    },
    recentCommands: []
  };
}

describe("mobile PWA snapshot truth", () => {
  it("renders an unavailable state without synthesizing account or market truth", () => {
    const html = renderToStaticMarkup(
      <MobileSnapshotUnavailable error="snapshot failed" onRetry={() => undefined} />
    );

    expect(html).toContain("Mobile data unavailable");
    expect(html).toContain("snapshot failed");
    expect(html).toContain("Retry");
    expect(html).not.toContain("Market Closed");
    expect(html).not.toContain("No pending proposals");
    expect(html).not.toContain("No positions");
  });
});

describe("mobile PWA run-state vocabulary (shared with the console — #2554)", () => {
  it("renders deriveStateInfo's word for every state — never a private systemState→label map", () => {
    expect(mobileRunState(undefined)).toBeNull();
    expect(mobileRunState({ systemState: "halted", strategyAuthority: "propose" })?.word).toBe("Stopped");
    expect(mobileRunState({ systemState: "close_only", strategyAuthority: "propose" })?.word).toBe("Exit-only");
    expect(mobileRunState({ systemState: "liquidating", strategyAuthority: "propose" })?.word).toBe("Winding down");
    // Without runDuringExtendedHours the market window is unknowable — plain Running,
    // same undefined-vs-false rule as the console (see deriveStateInfo).
    expect(mobileRunState({ systemState: "active", strategyAuthority: "decide" })?.word).toBe("Running");
  });

  it("says 'Paused · market closed' outside market hours exactly like the console (the PWA header once said 'Running')", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-13T16:00:00Z")); // Saturday noon ET — market closed
    const info = mobileRunState({ systemState: "active", strategyAuthority: "propose", runDuringExtendedHours: false });
    expect(info?.word).toBe("Paused · market closed");
    expect(info?.marketOpen).toBe(false);
  });
});

describe("mobile PWA command availability", () => {
  it("requires loaded, online, idle state and applies trading readiness separately", () => {
    expect(getMobileCommandAvailability(null, null, true, "unknown")).toEqual({
      canSubmit: false,
      canSubmitAccountCommand: false,
      canSubmitTrading: false,
      canSubmitStop: false,
      canSubmitAccountSwitch: false
    });
    expect(getMobileCommandAvailability(mobileSnapshot(), null, false, "fresh").canSubmitStop).toBe(false);
    expect(getMobileCommandAvailability(mobileSnapshot(), "watchlist.add", true, "fresh").canSubmitStop).toBe(false);

    const withStaleRunningCommand = mobileSnapshot();
    withStaleRunningCommand.recentCommands = [
      {
        id: "command-1",
        commandType: "watchlist.add",
        status: "running",
        createdAt: "2026-07-11T00:00:00.000Z",
        updatedAt: "2026-07-11T00:00:00.000Z"
      }
    ];
    expect(getMobileCommandAvailability(withStaleRunningCommand, null, true, "fresh").canSubmit).toBe(true);

    expect(getMobileCommandAvailability(mobileSnapshot({ hasAccount: false, hasUniverse: false }), null, true, "fresh")).toEqual({
      canSubmit: true,
      canSubmitAccountCommand: false,
      canSubmitTrading: false,
      canSubmitStop: true,
      canSubmitAccountSwitch: true
    });
    expect(getMobileCommandAvailability(mobileSnapshot({ hasUniverse: false }), null, true, "fresh")).toEqual({
      canSubmit: true,
      canSubmitAccountCommand: true,
      canSubmitTrading: false,
      canSubmitStop: true,
      canSubmitAccountSwitch: true
    });
    expect(getMobileCommandAvailability(mobileSnapshot(), null, true, "fresh")).toEqual({
      canSubmit: true,
      canSubmitAccountCommand: true,
      canSubmitTrading: true,
      canSubmitStop: true,
      canSubmitAccountSwitch: true
    });

    for (const freshness of ["unknown", "refreshing", "stale"] as const) {
      expect(getMobileCommandAvailability(mobileSnapshot(), null, true, freshness)).toEqual({
        canSubmit: false,
        canSubmitAccountCommand: false,
        canSubmitTrading: false,
        canSubmitStop: true,
        // Account switch stays available when snapshot is stale (metadata-only, immediate server path).
        canSubmitAccountSwitch: true
      });
    }
  });
});

describe("mobile PWA snapshot loading", () => {
  it("aborts a snapshot request at its deadline", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(
      (input: string, init: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          void input;
          void resolve;
          init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        })
    );

    const request = requestMobileSnapshot(fetcher, 1_000);
    const rejection = expect(request).rejects.toThrow("timed out after 1 seconds");
    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("coalesces overlapping refreshes and returns only the trailing truth", async () => {
    type Deferred = { promise: Promise<MobileSnapshot>; resolve: (snapshot: MobileSnapshot) => void };
    const deferreds: Deferred[] = [];
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const request = vi.fn(() => {
      let resolve!: (snapshot: MobileSnapshot) => void;
      const promise = new Promise<MobileSnapshot>((done) => {
        resolve = done;
      });
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      const tracked = promise.finally(() => {
        activeRequests -= 1;
      });
      deferreds.push({ promise: tracked, resolve });
      return tracked;
    });
    const loader = createCoalescedMobileSnapshotLoader(request);

    const first = loader.refresh();
    const overlapping = loader.refresh();
    expect(request).toHaveBeenCalledTimes(1);

    deferreds[0].resolve(mobileSnapshot({ selectedAccountNumber: "OLDER" }));
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    deferreds[1].resolve(mobileSnapshot({ selectedAccountNumber: "CURRENT" }));

    const [firstResult, overlappingResult] = await Promise.all([first, overlapping]);
    expect(firstResult.ok && firstResult.snapshot.readiness.selectedAccountNumber).toBe("CURRENT");
    expect(overlappingResult.ok && overlappingResult.snapshot.readiness.selectedAccountNumber).toBe("CURRENT");
    expect(maxActiveRequests).toBe(1);
  });
});

describe("mobile PWA command drafts", () => {
  it("clears only the unchanged draft after server acceptance", () => {
    expect(nextDraftAfterCommandAcceptance("AAPL", "AAPL", false, "")).toBe("AAPL");
    expect(nextDraftAfterCommandAcceptance("MSFT", "AAPL", true, "")).toBe("MSFT");
    expect(nextDraftAfterCommandAcceptance("AAPL", "AAPL", true, "")).toBe("");

    const submitted = { symbol: "AAPL", op: ">", price: "200" };
    const empty = { symbol: "", op: ">", price: "" };
    expect(nextDraftAfterCommandAcceptance(submitted, submitted, false, empty)).toBe(submitted);
    expect(nextDraftAfterCommandAcceptance(submitted, submitted, true, empty)).toBe(empty);

    const editedWhileSubmitting = { ...submitted, price: "205" };
    expect(nextDraftAfterCommandAcceptance(editedWhileSubmitting, submitted, true, empty)).toBe(editedWhileSubmitting);
  });
});

describe("mobile PWA command and authority labels", () => {
  it("humanizes known command types and title-cases unknown ones", () => {
    expect(commandLabel("strategy.run_once")).toBe("Strategy run");
    expect(commandLabel("proposal.approve")).toBe("Approve proposal");
    expect(commandLabel("strategy.stop")).toBe("Stop");
    expect(commandLabel("custom.snake_case")).toBe("Custom Snake Case");
  });

  it("maps strategy authority to Ask-first / Autopilot", () => {
    expect(strategyAuthorityLabel("propose")).toBe("Ask-first");
    expect(strategyAuthorityLabel("decide")).toBe("Autopilot");
    expect(strategyAuthorityLabel(null)).toBe("-");
    expect(strategyAuthorityLabel(undefined)).toBe("-");
  });
});

describe("mobile PWA proposal action feedback", () => {
  const proposalId = "prop-1";

  it("is null with no busy key, notice, or tracked command", () => {
    expect(proposalActionFeedback({ proposalId, busyKey: null })).toBeNull();
    // A busy key for a different proposal must not leak onto this card.
    expect(proposalActionFeedback({ proposalId, busyKey: "proposal.approve:other" })).toBeNull();
    expect(proposalActionFeedback({ proposalId, busyKey: "strategy.stop" })).toBeNull();
  });

  it("shows sending while this card's POST is in flight", () => {
    expect(proposalActionFeedback({ proposalId, busyKey: `proposal.approve:${proposalId}` })).toEqual({
      phase: "sending",
      action: "approve"
    });
    expect(proposalActionFeedback({ proposalId, busyKey: `proposal.reject:${proposalId}` })).toEqual({
      phase: "sending",
      action: "reject"
    });
  });

  it("follows the queued command through queued/running/succeeded/failed", () => {
    const base = { proposalId, busyKey: null };
    expect(
      proposalActionFeedback({ ...base, trackedCommand: { status: "queued", commandType: "proposal.approve" } })
    ).toEqual({ phase: "pending", action: "approve", status: "queued" });
    expect(
      proposalActionFeedback({ ...base, trackedCommand: { status: "running", commandType: "proposal.approve" } })
    ).toEqual({ phase: "pending", action: "approve", status: "running" });
    expect(
      proposalActionFeedback({ ...base, trackedCommand: { status: "succeeded", commandType: "proposal.reject" } })
    ).toEqual({ phase: "succeeded", action: "reject" });
    expect(
      proposalActionFeedback({
        ...base,
        trackedCommand: { status: "failed", commandType: "proposal.approve", error: "Proposal is already blocked." }
      })
    ).toEqual({ phase: "failed", action: "approve", message: "Proposal is already blocked." });
  });

  it("surfaces a worker failure even when the record has no error text", () => {
    expect(
      proposalActionFeedback({
        proposalId,
        busyKey: null,
        trackedCommand: { status: "failed", commandType: "proposal.approve" }
      })
    ).toEqual({ phase: "failed", action: "approve", message: "Command failed — see the command log below." });
  });

  it("prefers a submit-time notice over an older tracked command", () => {
    expect(
      proposalActionFeedback({
        proposalId,
        busyKey: null,
        notice: { message: "Command failed.", action: "approve" },
        trackedCommand: { status: "succeeded", commandType: "proposal.approve" }
      })
    ).toEqual({ phase: "failed", action: "approve", message: "Command failed." });
  });
});
