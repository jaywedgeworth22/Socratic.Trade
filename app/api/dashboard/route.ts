import { getDashboardSnapshot } from "@/lib/dashboard";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await getDashboardSnapshot());
}
