import { runStrategyOnce } from "@/lib/strategy";
import { resolveRequestUserId } from "@/lib/request-user";
import { getPolicy } from "@/lib/db";
import { resolveLlmEndpoint } from "@/lib/llm-provider";
import { eligibleRotationPool, isModelRotationSentinel } from "@/lib/model-rotation";
import {
  LLM_MODEL_REQUIRED_STRATEGY_MESSAGE,
  LLM_REQUIRED_STRATEGY_MESSAGE,
  LLM_ROTATION_AVAILABILITY_UNAVAILABLE_STRATEGY_MESSAGE,
  LLM_ROTATION_EMPTY_POOL_STRATEGY_MESSAGE
} from "@/lib/llm-required";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Production sits behind Cloudflare (~100s edge timeout). A real run's LLM steps run up to 150s
// EACH, so a manual run routinely takes 2-5+ minutes — awaiting runStrategyOnce() to completion
// here always 524s on the edge on anything but a trivially-fast run, even though the run itself
// keeps going server-side and finishes minutes later (owner-reported: the 524's raw Cloudflare
// HTML page was rendered as the run's "failure", when the run had actually succeeded).
//
// Fix: race runStrategyOnce() against a bounded window instead of always awaiting it fully.
//   - Fast paths (already-in-progress lock, no account, not agentic-allowed, halted/market-closed
//     skip — all of which resolve before runStrategyOnce ever reaches an LLM call) settle well
//     inside the window and are returned EXACTLY as before: same status codes, same summary
//     strings the console's classifyRunFailure()/deriveRunBlock() already parse. No behavior change
//     for any pre-flight block.
//   - A real multi-minute run blows through the window; we stop waiting and hand back a "started"
//     marker (202) instead of holding the connection open until Cloudflare kills it. The run keeps
//     executing — see trackDetached() below — and the console's existing strategy_runs snapshot
//     polling (listStrategyRuns via /api/dashboard) already renders an in-flight row as
//     status: "running" the instant insertStrategyRun() writes it (src/lib/db-execution.ts), which
//     happens synchronously before runStrategyOnce's first `await`, i.e. before this race even
//     starts timing — so a "started" response is never a lie about there being a run to track.
//   8s is comfortably under the ~100s edge budget while safely covering every pre-LLM fail-fast
//   path above; override via RUN_ONCE_SYNC_WINDOW_MS for tests.
function syncWindowMs(): number {
  const v = Number(process.env.RUN_ONCE_SYNC_WINDOW_MS);
  return Number.isFinite(v) && v > 0 ? v : 8_000;
}

// Detached-run tracker: pins in-flight run promises to globalThis so a) they survive this module
// being re-evaluated under Next.js HMR in dev, and b) any rejection is caught in exactly one place
// instead of surfacing as an unhandled-rejection warning. Mirrors the existing globalThis-pinned
// in-flight guards in src/lib/scheduler.ts (__stopMonitorInFlight, __staleExitInFlight) — this
// codebase's established pattern for fire-and-forget async work that must outlive the call that
// started it. This is safe here specifically because production (`next start` on Coolify, a
// persistent Node/nixpacks container — see AGENTS.md "Hosting & dev servers") is a normal
// long-lived Node process, NOT a serverless/edge runtime that freezes execution the instant a
// response is flushed: a promise nobody `await`s just keeps running on the ordinary event loop,
// exactly like the scheduler's own many `void someAsyncCall()` fire-and-forget calls already do.
// A naive detached promise would be just as alive here — the tracker only adds visibility/safety,
// it isn't what keeps the run running.
const detachedRunsHost = globalThis as unknown as { __runOnceDetachedRuns?: Set<Promise<unknown>> };
const detachedRuns: Set<Promise<unknown>> =
  detachedRunsHost.__runOnceDetachedRuns ?? (detachedRunsHost.__runOnceDetachedRuns = new Set());

function trackDetached(run: Promise<unknown>): void {
  detachedRuns.add(run);
  void run
    .catch((err) => console.error("[api/strategy/run] detached run error:", err))
    .finally(() => detachedRuns.delete(run));
}

export async function POST(request: Request) {
  const userId = resolveRequestUserId(request);
  const policy = getPolicy(userId);
  if (isModelRotationSentinel(policy.llmModel)) {
    // Green is "__rotate__": this precheck resolves the PERSISTED policy, where resolveOpenAiModel
    // deliberately treats the sentinel as unset (llm-request.ts safety net for non-run consumers),
    // so the key/model gates below would 412 EVERY manual run even though runStrategyOnce resolves
    // rotation to a concrete model at the top of the run (strategy.ts) — scheduled runs never hit
    // this precheck, which is why only Run-once was blocked. Gate on what the run will ACTUALLY
    // serve instead: the credential-filtered rotation pool. Non-empty means some concrete,
    // key-resolvable model serves this run — let it through. Empty means the run would fail closed
    // anyway (rotation resolves the seat to ""), so 412 now with the actionable rotation message.
    // (A RED "__rotate__" needs no gate here for the same reason a blank red model doesn't — see
    // the blank-red note below.)
    const eligible = await eligibleRotationPool(userId);
    if (eligible.pool.length === 0) {
      return NextResponse.json(
        {
          status: "failed",
          summary:
            eligible.availability === "unavailable"
              ? LLM_ROTATION_AVAILABILITY_UNAVAILABLE_STRATEGY_MESSAGE
              : LLM_ROTATION_EMPTY_POOL_STRATEGY_MESSAGE,
          proposals: []
        },
        { status: 412 }
      );
    }
  } else {
    // A strategy session is LLM-driven: gate it on a resolvable credential FOR THE MODEL proposeTrades
    // will actually call — resolveLlmEndpoint(policy).key, the same resolution the deep throw inside
    // proposeTrades uses — not "any provider". This makes the early 412 match the deep fail-loud throw,
    // so a user whose selected strategy model's provider has no key is blocked here instead of running a
    // loop that only errors deep inside proposeTrades. `summary` keeps the client's existing error rendering.
    const greenEndpoint = resolveLlmEndpoint(policy, userId);
    if (!greenEndpoint.key) {
      return NextResponse.json({ status: "failed", summary: LLM_REQUIRED_STRATEGY_MESSAGE, proposals: [] }, { status: 412 });
    }
    // NO MODEL DEFAULTS (owner directive 2026-07-07): a blank Green model resolves to "" and the deep
    // proposeTrades backstop fails closed with the same message — pre-check here so the user gets the
    // actionable 412 instead of a failed run. (A blank RED model does not 412: the run still produces
    // proposals, and debateProposal fails closed per-opening → routed to human approval, which is the
    // legible consequence the owner accepted for un-migrated policies.)
    if (!greenEndpoint.model) {
      return NextResponse.json({ status: "failed", summary: LLM_MODEL_REQUIRED_STRATEGY_MESSAGE, proposals: [] }, { status: 412 });
    }
  }
  const body = await request.json().catch(() => ({})) as { manual?: boolean } | null;

  // Launch the SAME execution path the scheduler uses (runStrategyOnce) without awaiting it to
  // completion. Its own audit/run-row lifecycle (insertStrategyRun/finishStrategyRun/audit(
  // "strategy_run", …)/releaseStrategyLock — all inside src/lib/strategy.ts) runs unchanged whether
  // or not this request is still around to see it finish.
  const runPromise = runStrategyOnce(userId, { manual: body?.manual === true });
  trackDetached(runPromise);

  const STARTED = Symbol("run-once:started");
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<typeof STARTED>((resolve) => {
    timeoutId = setTimeout(() => resolve(STARTED), syncWindowMs());
  });
  const winner = await Promise.race([runPromise, timeoutPromise]);
  clearTimeout(timeoutId);

  if (winner === STARTED) {
    return NextResponse.json(
      {
        runId: "",
        status: "started",
        summary: "Run started — LLM-driven runs can take a few minutes. Check Activity for progress.",
        proposals: []
      },
      { status: 202 }
    );
  }

  // audit("strategy_run", ...) is written inside runStrategyOnce() so the
  // scheduler path also records it — no need to write it here.
  const result = winner;
  return NextResponse.json(result, { status: result.status === "failed" ? 400 : 200 });
}
