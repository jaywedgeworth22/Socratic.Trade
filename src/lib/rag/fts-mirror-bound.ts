/**
 * Per-document FTS-mirror bounds (2026-08-14).
 *
 * #2680's 250ms adaptive yield inside `insertDocumentChunkFtsBatch` bounds a
 * single synchronous stretch.  It does NOT bound wall-clock: a 933-chunk filing
 * still ran 279522ms in one `embed_queued` tick (then 103s / 98s / 91s).  The
 * task lease is 60s and was heartbeated only during `storeDocument`, so the FTS
 * soak expired the lease, checkpoint advance failed, and the queue sat at
 * ~0.5% complete.
 *
 * This module is the bound ABOVE that yield: the worker must never feed the
 * batch helper a whole large filing in one call.  Each tick stops at N chunks
 * or a wall-clock budget, whichever first.  Resume is durable via the FTS row
 * count (what was actually written).
 *
 * Numbers below are computed from the live receipt, not comments.
 */

/** Live receipt: `ftsMirrorBatch 279522ms (933 chunks)`. */
export const FTS_MIRROR_INCIDENT_CHUNKS = 933;
export const FTS_MIRROR_INCIDENT_WALL_MS = 279_522;
export const FTS_MIRROR_INCIDENT_MS_PER_CHUNK =
  FTS_MIRROR_INCIDENT_WALL_MS / FTS_MIRROR_INCIDENT_CHUNKS;

/** Keep in lockstep with `FTS_BATCH_STRETCH_BUDGET_MS` in db-learning.ts. */
export const FTS_MIRROR_SYNC_STRETCH_BUDGET_MS = 250;

export const FTS_MIRROR_LEASE_MS = 60_000;
export const FTS_MIRROR_HEARTBEAT_MS = 20_000;

/**
 * Max chunks the worker may write across one embed_queued tick.
 * Chosen so production incident latency stays inside the tick wall budget:
 * 20 * (279522 / 933) = 5991.9ms <= 6000ms.
 */
export const FTS_MIRROR_MAX_CHUNKS_PER_TICK = 20;

/** Hard wall-clock budget for FTS work per embed_queued tick. */
export const FTS_MIRROR_TICK_BUDGET_MS = 6_000;

/**
 * Inner feed size so the tick can re-check the wall clock between calls.
 * Matches `insertDocumentChunkFtsBatch`'s starting group size.
 */
export const FTS_MIRROR_INNER_GROUP = 8;

export type FtsMirrorStopReason = "done" | "max-chunks" | "tick-budget" | "none";

export type FtsMirrorSlicePlan = {
  offset: number;
  end: number;
  chunkCount: number;
  remainingAfter: number;
  complete: boolean;
  stopReason: FtsMirrorStopReason;
  worstCaseSyncStretchMs: number;
  worstCaseTickWallMs: number;
};

/**
 * Plan the next inner FTS slice for this tick.  `offset` is how far the
 * document has already been mirrored (durable FTS row count).  `chunksDoneThisTick`
 * / `elapsedMs` are this lease's progress so the tick can stop at N chunks or
 * the wall budget, whichever first.
 */
export function planFtsMirrorSlice(input: {
  totalChunks: number;
  offset: number;
  chunksDoneThisTick?: number;
  elapsedMs?: number;
  maxChunksPerTick?: number;
  tickBudgetMs?: number;
  msPerChunk?: number;
  innerGroup?: number;
}): FtsMirrorSlicePlan {
  const total = Math.max(0, Math.floor(input.totalChunks));
  const offset = Math.min(total, Math.max(0, Math.floor(input.offset)));
  const doneThisTick = Math.max(0, Math.floor(input.chunksDoneThisTick ?? 0));
  const elapsed = Math.max(0, input.elapsedMs ?? 0);
  const maxChunks = Math.max(1, Math.floor(input.maxChunksPerTick ?? FTS_MIRROR_MAX_CHUNKS_PER_TICK));
  const tickBudget = Math.max(1, Math.floor(input.tickBudgetMs ?? FTS_MIRROR_TICK_BUDGET_MS));
  const msPerChunk = input.msPerChunk ?? FTS_MIRROR_INCIDENT_MS_PER_CHUNK;
  const inner = Math.max(1, Math.floor(input.innerGroup ?? FTS_MIRROR_INNER_GROUP));
  const remaining = total - offset;
  const worstCaseSyncStretchMs = FTS_MIRROR_SYNC_STRETCH_BUDGET_MS;

  if (remaining <= 0) {
    return {
      offset,
      end: offset,
      chunkCount: 0,
      remainingAfter: 0,
      complete: true,
      stopReason: "done",
      worstCaseSyncStretchMs,
      worstCaseTickWallMs: elapsed
    };
  }

  if (doneThisTick >= maxChunks) {
    return {
      offset,
      end: offset,
      chunkCount: 0,
      remainingAfter: remaining,
      complete: false,
      stopReason: "max-chunks",
      worstCaseSyncStretchMs,
      worstCaseTickWallMs: elapsed
    };
  }

  if (elapsed >= tickBudget) {
    return {
      offset,
      end: offset,
      chunkCount: 0,
      remainingAfter: remaining,
      complete: false,
      stopReason: "tick-budget",
      worstCaseSyncStretchMs,
      worstCaseTickWallMs: elapsed
    };
  }

  const remainingBudgetMs = tickBudget - elapsed;
  const budgetChunks =
    msPerChunk > 0 ? Math.max(1, Math.floor(remainingBudgetMs / msPerChunk)) : remaining;
  const chunkCount = Math.min(remaining, maxChunks - doneThisTick, budgetChunks, inner);
  const end = offset + chunkCount;
  const remainingAfter = total - end;
  const complete = remainingAfter === 0;
  let stopReason: FtsMirrorStopReason = "none";
  if (complete) stopReason = "done";
  else if (doneThisTick + chunkCount >= maxChunks) stopReason = "max-chunks";
  else if (chunkCount >= budgetChunks) stopReason = "tick-budget";

  return {
    offset,
    end,
    chunkCount,
    remainingAfter,
    complete,
    stopReason,
    worstCaseSyncStretchMs,
    worstCaseTickWallMs: elapsed + chunkCount * msPerChunk
  };
}

/**
 * True when a single FTS stretch can outlive the lease (the 2026-08-13/14
 * failure mode).  With a tick budget below the lease AND a heartbeat interval
 * below the lease, this is false.
 */
export function ftsMirrorLeaseExpiresDuringTick(input: {
  leaseMs?: number;
  tickBudgetMs?: number;
  /** `null` means no heartbeat ran during FTS (the incident). */
  heartbeatIntervalMs?: number | null;
} = {}): boolean {
  const lease = input.leaseMs ?? FTS_MIRROR_LEASE_MS;
  const tick = input.tickBudgetMs ?? FTS_MIRROR_TICK_BUDGET_MS;
  const heartbeat =
    input.heartbeatIntervalMs === undefined ? FTS_MIRROR_HEARTBEAT_MS : input.heartbeatIntervalMs;
  const uncovered = heartbeat == null ? tick : Math.min(tick, heartbeat);
  return uncovered >= lease;
}
