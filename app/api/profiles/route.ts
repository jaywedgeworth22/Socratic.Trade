import { createStrategyProfile, listStrategyProfiles } from "@/lib/db";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(listStrategyProfiles());
}

export async function POST(request: Request) {
  const body = await request.json();
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "New Strategy";
  const profile = createStrategyProfile({
    name,
    prompt: typeof body.prompt === "string" ? body.prompt : undefined,
    policy: typeof body.policy === "object" && body.policy ? body.policy : undefined,
    active: Boolean(body.active)
  });
  return NextResponse.json(profile);
}
