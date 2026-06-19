import { upsertConnectedAccount } from "@/lib/db";
import { NextResponse } from "next/server";
import crypto from "crypto";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const broker = body.broker === "alpaca" || body.broker === "robinhood" ? body.broker : undefined;
    const environment = body.environment === "paper" || body.environment === "live" ? body.environment : undefined;
    if (!broker || !environment) {
      return new NextResponse("broker and environment are required", { status: 400 });
    }
    const defaultLabel = `${broker === "alpaca" ? "Alpaca" : "Robinhood"} ${environment === "paper" ? "Paper" : "Live"}`;
    upsertConnectedAccount({
      id: body.id || crypto.randomUUID(),
      userId: "local",
      broker,
      environment,
      accountNumber: typeof body.accountNumber === "string" ? body.accountNumber.trim() || undefined : undefined,
      label: typeof body.label === "string" ? body.label.trim() || defaultLabel : defaultLabel,
      apiKey: typeof body.apiKey === "string" ? body.apiKey.trim() || undefined : undefined,
      apiSecret: typeof body.apiSecret === "string" ? body.apiSecret.trim() || undefined : undefined,
      isActive: body.isActive ?? false
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return new NextResponse(err instanceof Error ? err.message : "Error", { status: 400 });
  }
}
