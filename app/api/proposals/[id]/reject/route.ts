import { rejectProposal } from "@/lib/strategy";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    rejectProposal(id);
    return NextResponse.json({ status: "rejected" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to reject proposal.";
    return new NextResponse(message, { status: 400 });
  }
}
