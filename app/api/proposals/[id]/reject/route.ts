import { rejectProposal } from "@/lib/strategy";
import { getProposal } from "@/lib/db";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const userId = resolveRequestUserId(request);
    if (!getProposal(id, userId)) return new NextResponse("Proposal not found.", { status: 404 });
    rejectProposal(id, userId);
    return NextResponse.json({ status: "rejected" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to reject proposal.";
    return new NextResponse(message, { status: 400 });
  }
}
