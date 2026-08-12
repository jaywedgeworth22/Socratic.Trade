"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, Chip, Dot, Btn, Toggle, type ChipTone } from "../../console/ui/primitives";
import { DatabaseBackup, RefreshCw, ShieldCheck, ShieldAlert, HelpCircle, Hourglass, Layers, Layers2, Clock } from "lucide-react";
import { asRecord, readText } from "@/lib/server-metrics-shapes";

// Mirrors src/lib/runtime-health.ts's LitestreamCompactionTier ("0"|"1"|"2"|"3"|"9") — kept as a
// plain string union here (not imported) because this file is a client component and the
// source of truth is a server-only lib; the API response is the actual contract, parsed
// defensively below like every other admin panel that reads an untrusted JSON boundary.
type TierId = "0" | "1" | "2" | "3" | "9";

interface TierFreshness {
  tier: TierId;
  label: string;
  state: "known" | "unknown";
  newestActivityAt?: string;
  ageSeconds?: number;
  thresholdSeconds: number;
  degraded?: boolean;
}

interface BackupStatusData {
  liveMode: boolean;
  statePath: string;
  overall: {
    state: "known" | "unknown";
    status: string | null;
    lastSyncAt: string | null;
    ageSeconds: number | null;
    source: "ipc" | "file" | "none";
    degraded: boolean;
    reasons: string[];
  };
  tiers: TierFreshness[];
  tiersDegraded: boolean;
  asOf: string;
}

const KNOWN_TIER_IDS: readonly TierId[] = ["0", "1", "2", "3", "9"];

function parseTier(value: unknown): TierFreshness | undefined {
  const record = asRecord(value);
  const tier = record?.tier;
  if (typeof tier !== "string" || !KNOWN_TIER_IDS.includes(tier as TierId)) return undefined;
  const label = readText(record?.label) ?? `Level ${tier}`;
  const thresholdSeconds = typeof record?.thresholdSeconds === "number" && Number.isFinite(record.thresholdSeconds)
    ? record.thresholdSeconds
    : 0;
  const state = record?.state === "known" ? "known" : "unknown";
  if (state === "unknown") {
    return { tier: tier as TierId, label, state, thresholdSeconds };
  }
  const ageSeconds = typeof record?.ageSeconds === "number" && Number.isFinite(record.ageSeconds)
    ? record.ageSeconds
    : undefined;
  const newestActivityAt = readText(record?.newestActivityAt);
  if (ageSeconds === undefined || !newestActivityAt) {
    // Malformed "known" row (missing required fields) — treat as unknown rather than guess.
    return { tier: tier as TierId, label, state: "unknown", thresholdSeconds };
  }
  return {
    tier: tier as TierId,
    label,
    state,
    newestActivityAt,
    ageSeconds,
    thresholdSeconds,
    degraded: record?.degraded === true
  };
}

function parseBackupStatus(value: unknown): BackupStatusData | undefined {
  const root = asRecord(value);
  const overallRaw = asRecord(root?.overall);
  const statePath = readText(root?.statePath);
  const asOf = readText(root?.asOf);
  if (!root || !overallRaw || !statePath || !asOf || !Number.isFinite(Date.parse(asOf))) return undefined;

  const overallState = overallRaw.state === "known" ? "known" : "unknown";
  const source = overallRaw.source === "ipc" || overallRaw.source === "file" ? overallRaw.source : "none";
  const reasons = Array.isArray(overallRaw.reasons)
    ? overallRaw.reasons.filter((r): r is string => typeof r === "string")
    : [];
  const overallAgeSeconds = typeof overallRaw.ageSeconds === "number" && Number.isFinite(overallRaw.ageSeconds)
    ? overallRaw.ageSeconds
    : null;

  const tiersRaw = Array.isArray(root.tiers) ? root.tiers : [];
  const tiers = tiersRaw.map(parseTier).filter((t): t is TierFreshness => Boolean(t));
  // Missing/malformed tiers array from a future incompatible API shape — degrade to "no tier
  // data" rather than render a guessed/partial grid.
  if (tiers.length !== KNOWN_TIER_IDS.length) return undefined;

  return {
    liveMode: root.liveMode === true,
    statePath,
    overall: {
      state: overallState,
      status: readText(overallRaw.status) ?? null,
      lastSyncAt: readText(overallRaw.lastSyncAt) ?? null,
      ageSeconds: overallAgeSeconds,
      source,
      degraded: overallRaw.degraded === true,
      reasons
    },
    tiers,
    tiersDegraded: root.tiersDegraded === true,
    asOf
  };
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

const TIER_ICON: Record<TierId, React.ComponentType<{ size?: number | string; className?: string }>> = {
  "0": RefreshCw,
  "1": Layers,
  "2": Layers2,
  "3": Hourglass,
  "9": DatabaseBackup
};

const TIER_DESCRIPTION: Record<TierId, string> = {
  "0": "Raw WAL pages streamed to B2 continuously (litestream.coolify.yml syncs every 60s). The fastest-moving signal — it proves the app is writing and litestream is alive, but a healthy level 0 does NOT prove compaction or snapshots are working.",
  "1": "Periodic compaction merges level-0 segments into a denser replica. Runs on litestream's own internal cadence, not continuously — quiet gaps between runs are normal, a gap past the threshold below is not. A stuck compactor here can run for a long time without affecting level 0 at all, which is exactly what happened in production on 2026-08-11 (undetected for 27+ hours).",
  "2": "Second-stage compaction merging level-1 output into larger segments (5-minute monitor; output only appears when enough level-1 input has accumulated, so quiet stretches are normal). The 2026-08-12 production wedge lived exactly here — a byte-identical \"non-contiguous transaction ids\" retry every 5 minutes that the original 0/1/9 monitor could not see.",
  "3": "Third-stage rollup on an hourly monitor — same accumulation caveat as level 2, watched for the same reason: any level can wedge independently while every other level stays green.",
  "9": "Full daily snapshot (`snapshot.interval: 24h` in litestream.coolify.yml) — the point-in-time restore floor if every incremental LTX file were lost."
};

function tierTone(tier: TierFreshness): ChipTone {
  if (tier.state === "unknown") return "muted";
  return tier.degraded ? "neg" : "pos";
}

function tierStatusLabel(tier: TierFreshness): string {
  if (tier.state === "unknown") return "No activity observed yet";
  return tier.degraded ? "Stale" : "Healthy";
}

function overallTone(overall: BackupStatusData["overall"]): ChipTone {
  if (overall.state === "unknown") return "muted";
  return overall.degraded ? "neg" : "pos";
}

export function BackupStatusClient() {
  const [data, setData] = useState<BackupStatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [autoPoll, setAutoPoll] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/backup-status");
      const json: unknown = await res.json().catch(() => undefined);
      if (!res.ok) {
        setError(readText(asRecord(json)?.error) || `Failed to load backup status (HTTP ${res.status}).`);
        setLoading(false);
        setRefreshing(false);
        return;
      }
      const parsed = parseBackupStatus(json);
      if (parsed) {
        setData(parsed);
        setError(null);
      } else {
        setError("The backup status endpoint returned malformed data.");
      }
    } catch (err) {
      console.error(err);
      setError("Unable to reach the backup status endpoint.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    // Deferred via setTimeout(0) rather than called directly in the effect body — matches the
    // server-metrics-client.tsx precedent, which avoids the react-hooks/set-state-in-effect
    // cascading-render warning for this exact "kick off the initial fetch on mount" shape.
    const timer = window.setTimeout(() => {
      void fetchStatus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [fetchStatus]);

  useEffect(() => {
    if (!autoPoll) return;
    const timer = setInterval(() => void fetchStatus(), 30000);
    return () => clearInterval(timer);
  }, [autoPoll, fetchStatus]);

  if (loading) {
    return (
      <div className="flex h-[50vh] flex-col items-center justify-center gap-3">
        <RefreshCw className="h-8 w-8 animate-spin text-[color:var(--con-accent)]" />
        <span className="text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">Reading backup replication state...</span>
      </div>
    );
  }

  const anyDegraded = data ? (data.overall.degraded || data.tiersDegraded) : false;

  return (
    <div className="space-y-6">
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold">Backup Status</h1>
            {data && (
              <Chip tone={anyDegraded ? "neg" : "pos"}>
                {anyDegraded ? "ATTENTION NEEDED" : "HEALTHY"}
              </Chip>
            )}
            {data?.liveMode === false && <Chip tone="warn">NON-LIVE DB_BOOTSTRAP</Chip>}
          </div>
          <p className="mt-1 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
            Litestream SQLite replication to Backblaze B2, broken out per compaction tier.
          </p>
          {data && (
            <p className="mt-0.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
              As of {new Date(data.asOf).toLocaleString(undefined, { timeZone: "America/Chicago" })} &middot; state dir <code>{data.statePath}</code>
            </p>
          )}
        </div>
        <div className="flex items-center gap-3 self-start max-sm:w-full">
          <div className="flex items-center gap-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)] max-sm:mr-auto">
            <Toggle checked={autoPoll} onChange={setAutoPoll} label="Auto-refresh every 30 seconds" />
            Auto-refresh (30s)
          </div>
          <Btn
            variant="outline"
            size="sm"
            onClick={() => {
              setRefreshing(true);
              void fetchStatus();
            }}
            disabled={refreshing}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </Btn>
        </div>
      </header>

      {error && (
        <div className="rounded-[var(--con-radius-sm)] border border-[color:var(--con-neg-border)] bg-[color:var(--con-neg-soft)] p-4 text-[length:var(--con-fs-sm)] text-[color:var(--con-neg)]">
          <span className="font-semibold">Error:</span> {error}
          {data ? " Showing the last successfully loaded snapshot below." : ""}
        </div>
      )}

      {!data ? null : (
        <>
          {/* Overall replication signal (the pre-existing /api/health litestream* fields) */}
          <Card
            title={
              <span className="flex items-center gap-1.5">
                {data.overall.degraded ? <ShieldAlert className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
                Replication Daemon (IPC)
              </span>
            }
          >
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                <Dot tone={overallTone(data.overall)} pulse={data.overall.state === "unknown"} />
                <span className="font-semibold">
                  {data.overall.state === "unknown"
                    ? "Unavailable"
                    : data.overall.status ?? "unknown"}
                </span>
              </div>
              <div className="text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                Source: <span className="con-num">{data.overall.source}</span>
              </div>
              <div className="text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                Last sync age: <span className="con-num">{data.overall.ageSeconds === null ? "n/a" : formatDuration(data.overall.ageSeconds)}</span>
              </div>
            </div>
            <p className="mt-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
              This reads litestream&apos;s own IPC <code>/list</code> reply — it reports the database&apos;s overall
              last-sync time. That time tracks level 0 (below) and stays fresh even when a higher compaction
              level is stuck, which is exactly the gap the per-tier breakdown below exists to close.
            </p>
            {data.overall.reasons.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {data.overall.reasons.map((reason) => (
                  <Chip key={reason} tone="neg">{reason}</Chip>
                ))}
              </div>
            )}
          </Card>

          {/* Per-tier breakdown — the new signal */}
          <div className="grid gap-4 lg:grid-cols-3">
            {data.tiers.map((tier) => {
              const Icon = TIER_ICON[tier.tier];
              return (
                <Card
                  key={tier.tier}
                  title={
                    <span className="flex items-center gap-1.5">
                      <Icon className="h-4 w-4" /> {tier.label}
                      <span className="text-[color:var(--con-faint)] font-normal">(level {tier.tier})</span>
                    </span>
                  }
                >
                  <div className="flex items-center gap-2">
                    <Dot tone={tierTone(tier)} pulse={tier.state === "unknown"} />
                    <span className="font-semibold">{tierStatusLabel(tier)}</span>
                  </div>
                  <dl className="mt-3 space-y-1.5 text-[length:var(--con-fs-xs)]">
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-[color:var(--con-muted)]">Last activity</dt>
                      <dd className="con-num">
                        {tier.state === "unknown" || !tier.newestActivityAt
                          ? "None observed"
                          : new Date(tier.newestActivityAt).toLocaleString(undefined, { timeZone: "America/Chicago" })}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-[color:var(--con-muted)]">Age</dt>
                      <dd className="con-num">
                        {tier.state === "unknown" || tier.ageSeconds === undefined ? "n/a" : formatDuration(tier.ageSeconds)}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <dt className="flex items-center gap-1 text-[color:var(--con-muted)]"><Clock size={11} /> Threshold</dt>
                      <dd className="con-num">{formatDuration(tier.thresholdSeconds)}</dd>
                    </div>
                  </dl>
                  <p className="mt-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                    {TIER_DESCRIPTION[tier.tier]}
                  </p>
                </Card>
              );
            })}
          </div>

          <Card
            title={
              <span className="flex items-center gap-1.5">
                <HelpCircle className="h-4 w-4" /> Why per-tier detection
              </span>
            }
          >
            <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
              Litestream 0.5.x replicates SQLite in three independently-cadenced tiers. The
              replication daemon&apos;s own IPC status (above) and the pre-existing public
              <code> /api/health</code> probe both only reflect the database&apos;s overall
              last-sync time, which tracks level 0. A level-1 or level-9 tier can silently stop
              advancing for hours while level 0 keeps succeeding every minute &mdash; on
              2026-08-11 production ran with a wedged level-1 B2 compaction anchor for 27+ hours
              before anyone noticed, because every existing health signal stayed green the whole
              time. This panel reads the same local <code>ltx/&lt;level&gt;/</code> file mtimes
              litestream itself maintains on disk (no S3/B2 calls) so a stuck tier shows up here,
              and in <code>/api/health</code>&apos;s <code>checks.storage.litestreamTiers</code>
              field, well before it becomes a multi-day gap.
            </p>
          </Card>
        </>
      )}
    </div>
  );
}
