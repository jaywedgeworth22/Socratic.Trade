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
      body.broker === "alpaca" || body.broker === "alpaca-mcp" || body.broker === "robinhood" || body.broker === "test" ? body.broker : undefined;
    if (!broker) {
      return new NextResponse("broker is required (alpaca | robinhood | test)", { status: 400 });
    }
    const taxationType =
      body.taxationType === "roth_ira" || body.taxationType === "traditional_ira" || body.taxationType === "taxable"
        ? body.taxationType
        : undefined;

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
        taxationType: taxationType ?? existing?.taxationType,
        // Persist live capabilities from the broker so the UI can display them
        // and policy can enforce them without a round-trip on each strategy run.
        capabilities: agentic.capabilities ?? existing?.capabilities,
        isActive: body.isActive ?? existing?.isActive ?? !getActiveConnectedAccount(userId)
      });
      return NextResponse.json({ ok: true, accountNumber: agentic.accountNumber, label: agentic.label });
    }

    // Alpaca (paper-api vs api) and the local Test broker. For Alpaca, the environment
    // is differentiated strictly by the first 2 letters of the account number:
    // "PA..." (case-insensitive) represents Paper, otherwise it is Brokerage (live).
    if ((broker === "alpaca" || broker === "alpaca-mcp") && (!body.accountNumber || !body.accountNumber.trim())) {
      return new NextResponse("Account number is required for Alpaca", { status: 400 });
    }

    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    let environment: "paper" | "live" = "paper";
    if (broker === "alpaca" || broker === "alpaca-mcp") {
      const accNum = body.accountNumber.trim();
      environment = accNum.toUpperCase().startsWith("PA") ? "paper" : "live";
    } else if (broker === "test") {
      environment = "paper";
    } else {
      environment = body.environment === "live" ? "live" : "paper";
    }

    const defaultLabel =
      broker === "test"
        ? "Test"
        : broker === "alpaca-mcp"
          ? `Alpaca MCP ${environment === "paper" ? "Paper" : "Brokerage"}`
          : `Alpaca ${environment === "paper" ? "Paper" : "Brokerage"}`;

    upsertConnectedAccount({
      id: body.id || crypto.randomUUID(),
      userId,
      broker,
      environment,
      accountNumber: typeof body.accountNumber === "string" ? body.accountNumber.trim() || undefined : undefined,
      label: typeof body.label === "string" ? body.label.trim() || defaultLabel : defaultLabel,
      apiKey: apiKey || undefined,
      apiSecret: typeof body.apiSecret === "string" ? body.apiSecret.trim() || undefined : undefined,
      baseUrl: typeof body.baseUrl === "string" && body.baseUrl.trim()
        ? body.baseUrl.trim()
        : (broker === "alpaca" || broker === "alpaca-mcp")
          ? environment === "paper"
            ? "https://paper-api.alpaca.markets/v2"
            : "https://api.alpaca.markets/v2"
          : undefined,
      taxationType,
      isActive: body.isActive ?? false
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return new NextResponse(err instanceof Error ? err.message : "Error", { status: 400 });
  }
}
