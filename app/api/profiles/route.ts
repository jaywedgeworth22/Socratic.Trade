import { createStrategyProfile, listStrategyProfiles } from "@/lib/db";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return NextResponse.json(listStrategyProfiles(resolveRequestUserId(request)));
}

export async function POST(request: Request) {
  const body = await request.json();
  const userId = resolveRequestUserId(request, body);
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "New Strategy";
  const profile = createStrategyProfile({
    name,
    prompt: typeof body.prompt === "string" ? body.prompt : undefined,
    policy: typeof body.policy === "object" && body.policy ? body.policy : undefined,
    active: Boolean(body.active)
  }, userId);
  return NextResponse.json(profile);
}
