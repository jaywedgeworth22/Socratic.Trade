import { getInternalSetting } from "@/lib/db";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Coolify / Docker / Traefik liveness.  Cheap on purpose.
 *
 * `/api/health` is the rich public/ops probe and may return 503 when a
 * critical dependency hard-stops, or take longer than the Dockerfile
 * HEALTHCHECK timeout (5s).  Pointing Traefik at that probe marks a
 * serving container `running:unhealthy` and Cloudflare returns
 * `no available server` even though Next and Litestream are up — the
 * 2026-08-17 ~7:22–7:43pm CT window after docs-only #2810 finished.
 *
 * This route 200s when the process can answer HTTP and SQLite is
 * readable.  It does not inspect Pinecone, RAG, credits, or Litestream
 * freshness.  Those stay on `/api/health`.
 */
export async function GET() {
  try {
    getInternalSetting<string>("scheduler:lastTick");
    return NextResponse.json({ ok: true, probe: "live" }, { status: 200 });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        probe: "live",
        error: error instanceof Error ? error.message : "error"
      },
      { status: 503 }
    );
  }
}
