import { getPolicy, setPolicy } from "@/lib/db";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST() {
  const next = { ...getPolicy(), enabled: false };
  setPolicy(next);
  return NextResponse.json(next);
}
