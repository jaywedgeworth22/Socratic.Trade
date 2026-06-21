import { executeProposal } from "@/lib/strategy";
import { resolveRequestUserId } from "@/lib/request-user";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = resolveRequestUserId(request);
    const limited = enforceRateLimit(userId, "proposals/approve", RATE_LIMITS.orders);
    if (limited) return limited;
    const { id } = await params;
    const result = await executeProposal(id, userId);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to execute proposal.";
    if (message === "Proposal not found.") return new NextResponse(message, { status: 404 });
    return new NextResponse(message, { status: 400 });
  }
}
