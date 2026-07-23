import { getPolicy, setPolicy } from "@/lib/db";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const userId = resolveRequestUserId(request);
  const next = { ...getPolicy(userId), enabled: false, systemState: "halted" as const };
  setPolicy(next, userId);
  return NextResponse.json(next);
}
