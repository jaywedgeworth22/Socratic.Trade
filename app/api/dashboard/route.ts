import { getDashboardSnapshot } from "@/lib/dashboard";
import { resolveRequestUser } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = resolveRequestUser(request);
  return NextResponse.json(await getDashboardSnapshot(user.userId, user.email));
}
