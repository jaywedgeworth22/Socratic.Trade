import { upsertConnectedAccount } from "@/lib/db";
import { NextResponse } from "next/server";
import crypto from "crypto";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    upsertConnectedAccount({
      id: body.id || crypto.randomUUID(),
      userId: "local",
      broker: body.broker,
      environment: body.environment,
      accountNumber: body.accountNumber,
      label: body.label,
      apiKey: body.apiKey,
      apiSecret: body.apiSecret,
      isActive: body.isActive ?? false
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return new NextResponse(err instanceof Error ? err.message : "Error", { status: 400 });
  }
}
