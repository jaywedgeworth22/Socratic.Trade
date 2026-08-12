import { NextResponse } from "next/server";

export interface ScoutHealthResponse {
  ok: boolean;
  service: string;
  scoutStatus: "active" | "degraded" | "disabled";
  hostname: string;
  timestamp: string;
  coordination: {
    tunnelUrl: string;
    activeChannels: string[];
  };
}

export async function GET() {
  const tunnelUrl = process.env.SCOUT_TUNNEL_URL || "https://scout.jays.services";
  const payload: ScoutHealthResponse = {
    ok: true,
    service: "scout-coordinator",
    scoutStatus: "active",
    hostname: "scout.jays.services",
    timestamp: new Date().toISOString(),
    coordination: {
      tunnelUrl,
      activeChannels: ["congress-share", "market-signals", "eod-prices", "sec-filings"],
    },
  };

  return NextResponse.json(payload, {
    status: 200,
    headers: {
      "Cache-Control": "no-cache, no-store, must-revalidate",
    },
  });
}
