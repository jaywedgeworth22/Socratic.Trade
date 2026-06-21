import { executeProposal } from "@/lib/strategy";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const result = await executeProposal(id, resolveRequestUserId(request));
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to execute proposal.";
    if (message === "Proposal not found.") return new NextResponse(message, { status: 404 });
    return new NextResponse(message, { status: 400 });
  }
}
