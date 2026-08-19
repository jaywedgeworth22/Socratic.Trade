import { getDashboardSnapshot } from "@/lib/dashboard";
import { listMobileCommands, mobileControlCatalog, mobileReadiness } from "@/lib/mobile-api";
import { compactMobileMarketScan } from "@/lib/mobile-scan";
import { resolveRequestUser } from "@/lib/request-user";
import { listAlerts } from "@/lib/alerts";
import { listWatchlist } from "@/lib/watchlist";
import { isWorkingOrderState } from "@/lib/broker-held-orders";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = resolveRequestUser(request);
  const snapshot = await getDashboardSnapshot(user.userId, user.email);
  return NextResponse.json({
    currentUser: snapshot.currentUser,
    catalog: mobileControlCatalog(),
    readiness: mobileReadiness(user.userId),
    policy: {
      systemState: snapshot.policy.systemState,
      strategyAuthority: snapshot.policy.strategyAuthority,
      accountNumber: snapshot.policy.accountNumber ?? null,
      connectedAccountId: snapshot.policy.connectedAccountId ?? null,
      includedIndices: snapshot.policy.includedIndices,
      additionalSymbols: snapshot.policy.additionalSymbols,
      blocklist: snapshot.policy.blocklist ?? [],
      holdingHorizon: snapshot.policy.holdingHorizon,
      runCadenceMinutes: snapshot.policy.runCadenceMinutes,
      // Lets the PWA share the console's market-aware run-state vocabulary
      // (deriveStateInfo): without it "active" outside market hours renders
      // "Running" on mobile while the console says "Paused · market closed".
      runDuringExtendedHours: snapshot.policy.runDuringExtendedHours,
      maxOrderNotional: snapshot.policy.maxOrderNotional,
      maxOrderPctOfNav: snapshot.policy.maxOrderPctOfNav,
      maxDailyNotional: snapshot.policy.maxDailyNotional,
      maxDailyPctOfNav: snapshot.policy.maxDailyPctOfNav,
      maxDailyOrders: snapshot.policy.maxDailyOrders,
      requireTypedConfirmation: snapshot.policy.requireTypedConfirmation !== false
    },
    marketSession: snapshot.marketSession,
    scheduler: snapshot.scheduler,
    portfolio: snapshot.portfolio,
    positions: snapshot.positions,
    orders: snapshot.orders.filter(o => isWorkingOrderState(o.state)),
    pendingProposals: snapshot.pendingProposals,
    dailyStats: snapshot.dailyStats,
    performance: snapshot.performance,
    connectedAccounts: snapshot.connectedAccounts,
    watchlist: listWatchlist(user.userId),
    alerts: listAlerts(user.userId, "all"),
    recentCommands: listMobileCommands({ userId: user.userId, limit: 30 }),
    // Same last-good universe `/console/scan` paints when live Refresh 503s.
    latestScan: compactMobileMarketScan(snapshot.latestScan)
  });
}
