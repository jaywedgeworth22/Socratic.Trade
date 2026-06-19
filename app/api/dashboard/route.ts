import { getDashboardSnapshot } from "@/lib/dashboard";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return NextResponse.json(await getDashboardSnapshot(resolveRequestUserId(request)));
}
