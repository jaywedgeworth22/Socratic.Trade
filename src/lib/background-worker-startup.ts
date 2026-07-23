export interface BackgroundWorkerEnvironment {
  NODE_ENV?: string;
  VITEST?: string;
  DEV_BACKGROUND_WORKERS?: string;
}

export interface BackgroundWorkerDecision {
  enabled: boolean;
  environment: "production" | "development" | "test" | "unknown";
  reason: "production-default" | "non-production-opt-in" | "non-production-default-off";
}

export interface BackgroundWorkerStarters {
  startScheduler(): void;
  startUsageMonitorReplay(): void;
  startStreams(): void;
  startSecIngestWorker(): void;
}

export interface BackgroundWorkerStartupOptions {
  env?: BackgroundWorkerEnvironment;
  starters?: BackgroundWorkerStarters;
  log?: (message: string) => void;
}

const ENABLED_VALUES = new Set(["1", "true", "on", "yes"]);

function normalized(value: string | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function explicitlyEnabled(value: string | undefined): boolean {
  return ENABLED_VALUES.has(normalized(value));
}

function runtimeEnvironment(env: BackgroundWorkerEnvironment): BackgroundWorkerDecision["environment"] {
  const nodeEnv = normalized(env.NODE_ENV);
  if (nodeEnv === "test" || explicitlyEnabled(env.VITEST)) return "test";
  if (nodeEnv === "production") return "production";
  if (nodeEnv === "development") return "development";
  return "unknown";
}

/**
 * Production preserves the historical always-on boot contract. Every other runtime fails closed
 * unless a developer explicitly opts in, so `next dev`, Vitest, and ad-hoc scripts cannot silently
 * start broker/provider/RAG background work against a credentialed local database.
 */
export function resolveBackgroundWorkerDecision(
  env: BackgroundWorkerEnvironment = process.env
): BackgroundWorkerDecision {
  const environment = runtimeEnvironment(env);

  if (environment === "production") {
    return { enabled: true, environment, reason: "production-default" };
  }
  if (explicitlyEnabled(env.DEV_BACKGROUND_WORKERS)) {
    return { enabled: true, environment, reason: "non-production-opt-in" };
  }
  return { enabled: false, environment, reason: "non-production-default-off" };
}

async function loadDefaultStarters(): Promise<BackgroundWorkerStarters> {
  const [{ startScheduler }, { startUsageMonitorReplay }, { startStreams }, { startSecIngestWorker }] = await Promise.all([
    import("./scheduler"),
    import("./usage-monitor-replay"),
    import("./streams"),
    import("./rag/sec-ingest-worker"),
  ]);
  return { startScheduler, startUsageMonitorReplay, startStreams, startSecIngestWorker };
}

/** Resolve, report, and start the four process-level background worker families exactly once. */
export async function startServerBackgroundWorkers(
  options: BackgroundWorkerStartupOptions = {}
): Promise<BackgroundWorkerDecision> {
  const decision = resolveBackgroundWorkerDecision(options.env ?? process.env);
  const log = options.log ?? console.log;

  if (!decision.enabled) {
    log(
      `[background-workers] disabled (${decision.environment}; ` +
      "set DEV_BACKGROUND_WORKERS=on to opt in outside production)"
    );
    return decision;
  }

  log(`[background-workers] enabled (${decision.environment}; ${decision.reason})`);
  const starters = options.starters ?? await loadDefaultStarters();
  // startUsageMonitorReplay synchronously establishes the atomic all-ledger v2 boundary before
  // launching its first async send. It must precede every producer family, especially scheduler.
  starters.startUsageMonitorReplay();
  starters.startScheduler();
  starters.startStreams();
  starters.startSecIngestWorker(); // opt-in (SEC_INGEST_WORKER_ENABLED); self-gated, no-ops otherwise
  return decision;
}
