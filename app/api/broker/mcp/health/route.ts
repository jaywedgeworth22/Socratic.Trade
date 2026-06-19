import { NextResponse } from "next/server";
import { getRobinhoodMcpHealth } from "@/lib/robinhood";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getRobinhoodMcpHealth());
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        configured: false,
        authenticated: false,
        tools: [],
        checkedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : "Robinhood MCP health check failed."
      },
      { status: 500 }
    );
  }
}
