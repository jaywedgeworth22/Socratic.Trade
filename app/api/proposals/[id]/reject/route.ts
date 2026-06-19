import { rejectProposal } from "@/lib/strategy";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    rejectProposal(id, resolveRequestUserId(request));
    return NextResponse.json({ status: "rejected" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to reject proposal.";
    return new NextResponse(message, { status: 400 });
  }
}
