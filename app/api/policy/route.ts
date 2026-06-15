import { DEFAULT_POLICY } from "@/lib/defaults";
import { getPolicy, setPolicy, setStrategyPrompt } from "@/lib/db";
import { normalizeSymbol } from "@/lib/money";
import { getRobinhoodGateway } from "@/lib/robinhood";
import type { NotificationEventType, TradingPolicy } from "@/lib/types";
import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json(getPolicy());
}

export async function PUT(request: Request) {
  const body = await request.json();
  if (typeof body.strategyPrompt === "string") setStrategyPrompt(body.strategyPrompt);
  const current = getPolicy();
  const policy: TradingPolicy = {
    ...DEFAULT_POLICY,
    ...current,
    ...Object.fromEntries(Object.entries(body).filter(([key]) => key !== "strategyPrompt")),
    allowlist: Array.isArray(body.allowlist)
      ? Array.from(new Set(body.allowlist.map(String).map(normalizeSymbol).filter(Boolean)))
      : current.allowlist,
    scoringWeights: {
      ...DEFAULT_POLICY.scoringWeights,
      ...current.scoringWeights,
      ...(typeof body.scoringWeights === "object" && body.scoringWeights ? body.scoringWeights : {})
    },
    sectorCaps: normalizeSectorCaps(typeof body.sectorCaps === "object" && body.sectorCaps ? body.sectorCaps : current.sectorCaps),
    riskRules: {
      ...DEFAULT_POLICY.riskRules,
      ...current.riskRules,
      ...(typeof body.riskRules === "object" && body.riskRules ? body.riskRules : {})
    },
    notificationSettings: {
      ...DEFAULT_POLICY.notificationSettings,
      ...current.notificationSettings,
      ...(typeof body.notificationSettings === "object" && body.notificationSettings ? body.notificationSettings : {}),
      enabledEvents:
        typeof body.notificationSettings === "object" &&
        body.notificationSettings &&
        Array.isArray(body.notificationSettings.enabledEvents)
          ? body.notificationSettings.enabledEvents.filter(isNotificationEvent)
          : current.notificationSettings.enabledEvents
    }
  };
  const validationError = await validatePolicy(policy);
  if (validationError) return new NextResponse(validationError, { status: 400 });
  setPolicy(policy);
  return NextResponse.json(policy);
}

async function validatePolicy(policy: TradingPolicy): Promise<string | undefined> {
  if (!["custom", "sp500"].includes(policy.universe)) return "universe must be custom or sp500.";
  if (!["propose", "decide"].includes(policy.strategyAuthority)) return "strategyAuthority must be propose or decide.";
  if (policy.maxOrderNotional <= 0) return "maxOrderNotional must be positive.";
  if (policy.maxDailyNotional < policy.maxOrderNotional) return "maxDailyNotional must be at least maxOrderNotional.";
  if (policy.maxSymbolExposurePct <= 0 || policy.maxSymbolExposurePct > 100) return "maxSymbolExposurePct must be between 0 and 100.";
  if (policy.maxDailyOrders <= 0) return "maxDailyOrders must be positive.";
  if (policy.runCadenceMinutes < 1) return "runCadenceMinutes must be at least 1 minute.";
  if (Object.values(policy.scoringWeights).some((value) => !Number.isFinite(Number(value)) || Number(value) < 0)) return "scoring weights must be non-negative numbers.";
  if (Object.values(policy.sectorCaps).some((value) => !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 100)) return "sector caps must be between 0 and 100.";
  if (Object.values(policy.riskRules).some((value) => value !== undefined && (!Number.isFinite(Number(value)) || Number(value) < 0))) return "risk rules must be non-negative numbers.";
  if (policy.notificationSettings.webhookUrl?.trim()) {
    try {
      new URL(policy.notificationSettings.webhookUrl);
    } catch {
      return "webhookUrl must be a valid URL.";
    }
  }
  if (policy.enabled && !policy.accountNumber) return "Select an account before enabling autonomy.";
  if (policy.enabled && policy.universe === "custom" && policy.allowlist.length === 0) return "Configure an allowlist before enabling autonomy.";
  if (policy.enabled && policy.accountNumber) {
    const account = (await getRobinhoodGateway().getAccounts()).find((item) => item.accountNumber === policy.accountNumber);
    if (!account) return "Selected account is not available.";
    if (!account.agenticAllowed) return "Selected account is not agentic_allowed.";
  }
}

function normalizeSectorCaps(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, raw]) => [key.trim(), Number(raw)] as const)
      .filter(([key, cap]) => key.length > 0 && Number.isFinite(cap))
  );
}

function isNotificationEvent(value: unknown): value is NotificationEventType {
  return ["fill", "block", "run_failed", "pending_approval", "kill_switch"].includes(String(value));
}
