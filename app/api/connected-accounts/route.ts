import { getActiveConnectedAccount, listConnectedAccounts, upsertConnectedAccount } from "@/lib/db";
import { getRobinhoodGateway } from "@/lib/robinhood";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";
import crypto from "crypto";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const userId = resolveRequestUserId(req, body);
    const broker =
      body.broker === "alpaca" || body.broker === "robinhood" || body.broker === "test" ? body.broker : undefined;
    if (!broker) {
      return new NextResponse("broker is required (alpaca | robinhood | test)", { status: 400 });
    }

    // Robinhood: sync the real agentic (read+write) account from the live MCP — never a
    // hand-typed number, and never the read-only Investing/Roth IRA accounts. Requires the
    // Robinhood MCP to already be connected (OAuth complete).
    if (broker === "robinhood") {
      const accounts = await getRobinhoodGateway().getAccounts();
      const agentic = accounts.find((a) => a.agenticAllowed);
      if (!agentic) {
        return new NextResponse(
          "No agentic-enabled Robinhood account found. Connect your Robinhood agentic account first.",
          { status: 400 }
        );
      }
      // Idempotent: reuse the existing row for this account if already synced (no duplicate
      // rows on re-sync), and activate it on first connect (when nothing else is active yet).
      const existing = listConnectedAccounts(userId).find(
        (a) => a.broker === "robinhood" && a.accountNumber === agentic.accountNumber
      );
      upsertConnectedAccount({
        id: existing?.id ?? body.id ?? crypto.randomUUID(),
        userId,
        broker: "robinhood",
        environment: "live",
        accountNumber: agentic.accountNumber,
        label: agentic.label || "Robinhood Agentic",
        isActive: body.isActive ?? existing?.isActive ?? !getActiveConnectedAccount(userId)
      });
      return NextResponse.json({ ok: true, accountNumber: agentic.accountNumber, label: agentic.label });
    }

    // Alpaca (paper-api vs api) and the local Test broker. For Alpaca, the API KEY
    // PREFIX is authoritative for paper vs brokerage — "PK…" = Paper (paper-api),
    // "AK…" = Brokerage (live api). That prefix is what actually decides which Alpaca
    // endpoint the key works against, so it overrides whichever button was clicked.
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    let environment: "paper" | "live" = body.environment === "live" ? "live" : "paper";
    if (broker === "alpaca" && apiKey) {
      if (apiKey.toUpperCase().startsWith("PK")) environment = "paper";
      else if (apiKey.toUpperCase().startsWith("AK")) environment = "live";
    }
    const defaultLabel =
      broker === "test" ? "Test" : `Alpaca ${environment === "paper" ? "Paper" : "Brokerage"}`;
    upsertConnectedAccount({
      id: body.id || crypto.randomUUID(),
      userId,
      broker,
      environment,
      accountNumber: typeof body.accountNumber === "string" ? body.accountNumber.trim() || undefined : undefined,
      label: typeof body.label === "string" ? body.label.trim() || defaultLabel : defaultLabel,
      apiKey: apiKey || undefined,
      apiSecret: typeof body.apiSecret === "string" ? body.apiSecret.trim() || undefined : undefined,
      isActive: body.isActive ?? false
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return new NextResponse(err instanceof Error ? err.message : "Error", { status: 400 });
  }
}
