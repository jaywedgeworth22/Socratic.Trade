import { getStrategyProfile, updateStrategyProfile } from "@/lib/db";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const profile = getStrategyProfile(id);
  if (!profile) return new NextResponse("Profile not found.", { status: 404 });
  return NextResponse.json(profile);
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json();
  try {
    const profile = updateStrategyProfile(id, {
      name: typeof body.name === "string" ? body.name.trim() : undefined,
      prompt: typeof body.prompt === "string" ? body.prompt : undefined,
      policy: typeof body.policy === "object" && body.policy ? body.policy : undefined,
      scoringWeights: typeof body.scoringWeights === "object" && body.scoringWeights ? body.scoringWeights : undefined
    });
    return NextResponse.json(profile);
  } catch (error) {
    return new NextResponse(error instanceof Error ? error.message : "Profile update failed.", { status: 400 });
  }
}
