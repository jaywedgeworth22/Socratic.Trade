import { getInternalSetting } from "./db-settings";
import { getDb, getPolicy, getLastStrategyRunStartedAt, listConnectedAccounts, listUsers } from "./db";
import { userHasAnyLlmCredential } from "./db-api-keys";
import { resolveLlmEndpoint } from "./llm-provider";

const OPS_AUDIT_KINDS = new Set([
  "strategy_run",
  "recoverable_issue",
  "run_skipped_score_threshold",
  "run_skipped_market_closed",
  "policy_violation_drawdown",
  "policy_violation_vol_panic",
  "policy_violation_cap_exceeded",
  "autonomy_halted_on_boot",
  "order_placement_uncertain",
  "proposal_skipped_negative_ev"
]);

export interface OpsAccountSnapshot {
  connectedAccountId: string;
  label: string;
  broker: string;
  accountNumber: string | null;
  isActive: boolean;
  systemState: string;
  strategyAuthority: string;
  llmModel: string | null;
  redTeamLlmModel: string | null;
  llmProvider: string | null;
  llmKeyConfigured: boolean;
  lastRunStartedAt: string | null;
}

export interface OpsStrategyRunRow {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  summary: string | null;
  connectedAccountId: string | null;
  accountLabel: string | null;
  placedCount: number;
  paperCount: number;
  blockedCount: number;
  proposedCount: number;
}

export interface OpsAuditRow {
  id: string;
  createdAt: string;
  kind: string;
  connectedAccountId: string | null;
  accountLabel: string | null;
  detail: string;
}

export interface OpsUserSnapshot {
  userId: string;
  llmAnyProviderConfigured: boolean;
  accounts: OpsAccountSnapshot[];
  recentRuns: OpsStrategyRunRow[];
  recentAudit: OpsAuditRow[];
}

export interface OpsSnapshot {
  asOf: string;
  schedulerLastTick: string | null;
  schedulerAgeSeconds: number | null;
  users: OpsUserSnapshot[];
}

function accountLabelById(userId: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const account of listConnectedAccounts(userId)) {
    map.set(account.id, account.label || account.broker);
  }
  return map;
}

function sanitizeAuditDetail(kind: string, payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const p = payload as Record<string, unknown>;
  if (kind === "strategy_run") {
    const status = typeof p.status === "string" ? p.status : "unknown";
    const summary = typeof p.summary === "string" ? p.summary : "";
    const proposals = Array.isArray(p.proposals) ? p.proposals.length : 0;
    return [status, summary, proposals > 0 ? `${proposals} proposal(s)` : ""].filter(Boolean).join(" · ");
  }
  if (kind === "recoverable_issue") {
    const message = typeof p.message === "string" ? p.message : "";
    const fallback = typeof p.fallback === "string" ? p.fallback : "";
    const operation = typeof p.operation === "string" ? p.operation : "";
    return [operation, message, fallback ? `fallback: ${fallback}` : ""].filter(Boolean).join(" · ");
  }
  const reason = typeof p.reason === "string" ? p.reason : "";
  const summary = typeof p.summary === "string" ? p.summary : "";
  const message = typeof p.message === "string" ? p.message : "";
  return reason || summary || message || JSON.stringify(p).slice(0, 240);
}

function listOpsStrategyRuns(userId: string, limit: number, labels: Map<string, string>): OpsStrategyRunRow[] {
  type Raw = {
    id: string;
    started_at: string;
    finished_at: string | null;
    status: string;
    summary: string | null;
    connected_account_id: string | null;
    placed_count: number;
    paper_count: number;
    blocked_count: number;
    proposed_count: number;
  };
  const rows = getDb()
    .prepare(
      `SELECT
        sr.id,
        sr.started_at,
        sr.finished_at,
        sr.status,
        sr.summary,
        sr.connected_account_id,
        COUNT(CASE WHEN tp.status = 'placed' THEN 1 END) AS placed_count,
        COUNT(CASE WHEN tp.status = 'paper' THEN 1 END) AS paper_count,
        COUNT(CASE WHEN tp.status = 'blocked' THEN 1 END) AS blocked_count,
        COUNT(CASE WHEN tp.status = 'proposed' THEN 1 END) AS proposed_count
       FROM strategy_runs sr
       LEFT JOIN trade_proposals tp ON tp.run_id = sr.id
       WHERE sr.user_id = ?
       GROUP BY sr.id
       ORDER BY sr.started_at DESC
       LIMIT ?`
    )
    .all(userId, limit) as Raw[];

  return rows.map((row) => ({
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    summary: row.summary,
    connectedAccountId: row.connected_account_id,
    accountLabel: row.connected_account_id ? labels.get(row.connected_account_id) ?? null : null,
    placedCount: row.placed_count,
    paperCount: row.paper_count,
    blockedCount: row.blocked_count,
    proposedCount: row.proposed_count
  }));
}

function listOpsAudit(userId: string, limit: number, labels: Map<string, string>): OpsAuditRow[] {
  const placeholders = Array.from(OPS_AUDIT_KINDS).map(() => "?").join(", ");
  const rows = getDb()
    .prepare(
      `SELECT id, connected_account_id, created_at, kind, payload
       FROM audit_events
       WHERE user_id = ? AND kind IN (${placeholders})
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(userId, ...Array.from(OPS_AUDIT_KINDS), limit) as Array<{
    id: string;
    connected_account_id: string | null;
    created_at: string;
    kind: string;
    payload: string;
  }>;

  return rows.map((row) => {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      payload = {};
    }
    return {
      id: row.id,
      createdAt: row.created_at,
      kind: row.kind,
      connectedAccountId: row.connected_account_id,
      accountLabel: row.connected_account_id ? labels.get(row.connected_account_id) ?? null : null,
      detail: sanitizeAuditDetail(row.kind, payload)
    };
  });
}

function llmKeyConfiguredForPolicy(userId: string, llmModel: string | null | undefined): boolean {
  try {
    return Boolean(resolveLlmEndpoint({ llmModel }, userId).key);
  } catch {
    return false;
  }
}

export function buildOpsSnapshot(input: { runsPerUser?: number; auditPerUser?: number } = {}): OpsSnapshot {
  const runsPerUser = input.runsPerUser ?? 20;
  const auditPerUser = input.auditPerUser ?? 40;
  const lastTick = getInternalSetting<string>("scheduler:lastTick");
  const tickMs = lastTick ? Date.parse(lastTick) : Number.NaN;

  const users: OpsUserSnapshot[] = [];
  for (const userId of listUsers()) {
    const labels = accountLabelById(userId);
    const accounts: OpsAccountSnapshot[] = listConnectedAccounts(userId).map((account) => {
      const policy = getPolicy(userId, account.id);
      const endpoint = resolveLlmEndpoint(policy, userId);
      return {
        connectedAccountId: account.id,
        label: account.label || account.broker,
        broker: account.broker,
        accountNumber: account.accountNumber ?? null,
        isActive: account.isActive,
        systemState: policy.systemState,
        strategyAuthority: policy.strategyAuthority,
        llmModel: policy.llmModel ?? null,
        redTeamLlmModel: policy.redTeamLlmModel ?? null,
        llmProvider: endpoint.provider,
        llmKeyConfigured: llmKeyConfiguredForPolicy(userId, policy.llmModel),
        lastRunStartedAt: getLastStrategyRunStartedAt(userId, account.id)
      };
    });

    users.push({
      userId,
      llmAnyProviderConfigured: userHasAnyLlmCredential(userId),
      accounts,
      recentRuns: listOpsStrategyRuns(userId, runsPerUser, labels),
      recentAudit: listOpsAudit(userId, auditPerUser, labels)
    });
  }

  return {
    asOf: new Date().toISOString(),
    schedulerLastTick: lastTick ?? null,
    schedulerAgeSeconds: Number.isFinite(tickMs) ? Math.round((Date.now() - tickMs) / 1000) : null,
    users
  };
}
