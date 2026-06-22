import { DEFAULT_POLICY, DEFAULT_TAX_SETTINGS } from "@/lib/defaults";
import { getPolicy, setPolicy, setStrategyPrompt } from "@/lib/db";
import { isIndexUniverse, isValidAppSymbol } from "@/lib/index-universes";
import { normalizeSymbol } from "@/lib/money";
import { getBrokerGateway } from "@/lib/broker";
import { resolveRequestUserId } from "@/lib/request-user";
import type { NotificationEventType, TradingPolicy, IndexUniverse } from "@/lib/types";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return NextResponse.json(getPolicy(resolveRequestUserId(request)));
}

export async function PUT(request: Request) {
  const body = await request.json();
  const userId = resolveRequestUserId(request, body);
  if (typeof body.strategyPrompt === "string") setStrategyPrompt(body.strategyPrompt, userId);
  const current = getPolicy(userId);
  const policy: TradingPolicy = {
    ...DEFAULT_POLICY,
    ...current,
    ...Object.fromEntries(Object.entries(body).filter(([key]) => key !== "strategyPrompt" && key !== "userId")),
    includedIndices: Array.isArray(body.includedIndices)
      ? Array.from(new Set(body.includedIndices.map(String).filter(isIndexUniverse))) as IndexUniverse[]
      : current.includedIndices,
    additionalSymbols: Array.isArray(body.additionalSymbols)
      ? Array.from(new Set(body.additionalSymbols.map(String).map(normalizeSymbol).filter(Boolean)))
      : current.additionalSymbols,
    blocklist: Array.isArray(body.blocklist)
      ? Array.from(new Set(body.blocklist.map(String).map(normalizeSymbol).filter(Boolean)))
      : current.blocklist,
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
    },
    taxSettings: {
      ...DEFAULT_TAX_SETTINGS,
      ...current.taxSettings,
      ...(typeof body.taxSettings === "object" && body.taxSettings ? body.taxSettings : {})
    },
    tuning: {
      ...current.tuning,
      ...(typeof body.tuning === "object" && body.tuning ? body.tuning : {})
    }
  };
  const validationError = await validatePolicy(policy, userId);
  if (validationError) return new NextResponse(validationError, { status: 400 });
  setPolicy(policy, userId);
  return NextResponse.json(policy);
}

async function validatePolicy(policy: TradingPolicy, userId: string): Promise<string | undefined> {
  for (const symbol of policy.additionalSymbols || []) {
    if (!isValidAppSymbol(symbol)) return `Symbol ${symbol} in additional watchlist is not supported by the app.`;
  }
  for (const symbol of policy.blocklist || []) {
    if (!isValidAppSymbol(symbol)) return `Symbol ${symbol} in ignore list is not supported by the app.`;
  }

  if (!["propose", "decide"].includes(policy.strategyAuthority)) return "strategyAuthority must be propose or decide.";
  if (policy.holdingHorizon && !["intraday", "swing", "position", "longterm"].includes(policy.holdingHorizon)) return "holdingHorizon must be intraday, swing, position, or longterm.";
  if (policy.maxOrderNotional !== undefined && policy.maxOrderNotional <= 0) return "maxOrderNotional must be positive.";
  if (policy.maxOrderPctOfNav !== undefined && (policy.maxOrderPctOfNav <= 0 || policy.maxOrderPctOfNav > 100)) return "maxOrderPctOfNav must be between 0 and 100.";
  if (policy.maxDailyNotional !== undefined && policy.maxOrderNotional !== undefined && policy.maxDailyNotional < policy.maxOrderNotional) return "maxDailyNotional must be at least maxOrderNotional.";
  if (policy.maxSymbolExposurePct !== undefined && (policy.maxSymbolExposurePct <= 0 || policy.maxSymbolExposurePct > 100)) return "maxSymbolExposurePct must be between 0 and 100.";
  if (policy.maxDailyOrders <= 0) return "maxDailyOrders must be positive.";
  if (policy.runCadenceMinutes < 1) return "runCadenceMinutes must be at least 1 minute.";
  if (policy.proposalExpiryMinutes !== undefined && (!Number.isFinite(policy.proposalExpiryMinutes) || policy.proposalExpiryMinutes < 0)) return "proposalExpiryMinutes must be 0 (off) or a positive number of minutes.";
  if (policy.proposalRevalidateCadenceHours !== undefined && (!Number.isFinite(policy.proposalRevalidateCadenceHours) || policy.proposalRevalidateCadenceHours < 0)) return "proposalRevalidateCadenceHours must be 0 (off) or a positive number of hours.";
  if (Object.values(policy.scoringWeights).some((value) => !Number.isFinite(Number(value)) || Number(value) < 0)) return "scoring weights must be non-negative numbers.";
  if (Object.values(policy.sectorCaps).some((value) => !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 100)) return "sector caps must be between 0 and 100.";
  if (Object.values(policy.riskRules).some((value) => value !== undefined && (!Number.isFinite(Number(value)) || Number(value) < 0))) return "risk rules must be non-negative numbers.";
  if (policy.taxSettings) {
    const { shortTermRatePct, longTermRatePct } = policy.taxSettings;
    if (!Number.isFinite(shortTermRatePct) || shortTermRatePct < 0 || shortTermRatePct > 100) return "shortTermRatePct must be between 0 and 100.";
    if (!Number.isFinite(longTermRatePct) || longTermRatePct < 0 || longTermRatePct > 100) return "longTermRatePct must be between 0 and 100.";
  }
  if (policy.tuning) {
    const { shrinkPrior, minClosedLotsForWeightShift, sizingFloorPct, sizingCeilingPct, redTeamConvictionThreshold, crisisMaxOpeningExposurePct } = policy.tuning;
    if (shrinkPrior !== undefined && (!Number.isFinite(shrinkPrior) || shrinkPrior < 0 || shrinkPrior > 100)) return "tuning.shrinkPrior must be between 0 and 100.";
    if (minClosedLotsForWeightShift !== undefined && (!Number.isFinite(minClosedLotsForWeightShift) || minClosedLotsForWeightShift < 1 || minClosedLotsForWeightShift > 1000)) return "tuning.minClosedLotsForWeightShift must be between 1 and 1000.";
    if (sizingFloorPct !== undefined && (!Number.isFinite(sizingFloorPct) || sizingFloorPct < 0 || sizingFloorPct > 100)) return "tuning.sizingFloorPct must be between 0 and 100.";
    if (sizingCeilingPct !== undefined && (!Number.isFinite(sizingCeilingPct) || sizingCeilingPct < 1 || sizingCeilingPct > 100)) return "tuning.sizingCeilingPct must be between 1 and 100.";
    if (sizingFloorPct !== undefined && sizingCeilingPct !== undefined && sizingFloorPct > sizingCeilingPct) return "tuning.sizingFloorPct must not exceed sizingCeilingPct.";
    if (redTeamConvictionThreshold !== undefined && (!Number.isFinite(redTeamConvictionThreshold) || redTeamConvictionThreshold < 0 || redTeamConvictionThreshold > 100)) return "tuning.redTeamConvictionThreshold must be between 0 and 100.";
    if (crisisMaxOpeningExposurePct !== undefined && (!Number.isFinite(crisisMaxOpeningExposurePct) || crisisMaxOpeningExposurePct < 0 || crisisMaxOpeningExposurePct > 100)) return "tuning.crisisMaxOpeningExposurePct must be between 0 and 100.";
  }
  if (policy.notificationSettings.webhookUrl?.trim()) {
    try {
      new URL(policy.notificationSettings.webhookUrl);
    } catch {
      return "webhookUrl must be a valid URL.";
    }
  }
  if (policy.systemState === "active" && !policy.accountNumber) return "Select an account before enabling autonomy.";
  if (policy.systemState === "active" && policy.includedIndices.length === 0 && policy.additionalSymbols.length === 0) return "Select at least one base index or additional watchlist symbol before enabling autonomy.";
  if (policy.systemState === "active" && policy.accountNumber) {
    const account = (await getBrokerGateway(policy, userId).getAccounts()).find((item) => item.accountNumber === policy.accountNumber);
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
  return ["fill", "block", "run_failed", "pending_approval", "kill_switch", "price_alert", "proposal_withdrawn"].includes(String(value));
}
