import { getActiveConnectedAccount, listConnectedAccounts, upsertConnectedAccount } from "@/lib/db";
import { getRobinhoodGateway } from "@/lib/robinhood";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";
import crypto from "crypto";

export const dynamic = "force-dynamic";

const TEST_ACCOUNT_LABEL = "Test Account";
const TEST_ACCOUNT_NUMBER = "TEST";

function isAlpacaPaperCredential(input: { accountNumber?: unknown; apiKey?: unknown }): boolean {
  const accountNumber = typeof input.accountNumber === "string" ? input.accountNumber.trim().toUpperCase() : "";
  const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim().toUpperCase() : "";
  return accountNumber.startsWith("PA") || apiKey.startsWith("PK");
}

// List the user's connected accounts for the UI (e.g. the copy-strategy-to-account picker).
// listConnectedAccounts never includes secrets; we still project an explicit safe subset.
export async function GET(req: Request) {
  const userId = resolveRequestUserId(req);
  const accounts = listConnectedAccounts(userId).map((a) => ({
    id: a.id,
    broker: a.broker,
    environment: a.environment,
    accountNumber: a.accountNumber,
    label: a.label,
    taxationType: a.taxationType,
    isActive: a.isActive
  }));
  return NextResponse.json({ accounts });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const userId = resolveRequestUserId(req, body);
    const broker =
      body.broker === "alpaca" || body.broker === "alpaca-mcp" || body.broker === "robinhood" || body.broker === "test" || body.broker === "tradier" ? body.broker : undefined;
    if (!broker) {
      return new NextResponse("broker is required (alpaca | robinhood | test | tradier)", { status: 400 });
    }
    const taxationType =
      body.taxationType === "roth_ira" || body.taxationType === "traditional_ira" || body.taxationType === "taxable"
        ? body.taxationType
        : undefined;

    // Robinhood: sync the real agentic (read+write) account from the live MCP — never a
    // hand-typed number, and never the read-only Investing/Roth IRA accounts. Requires the
    // Robinhood MCP to already be connected (OAuth complete).
    if (broker === "robinhood") {
      const accounts = await getRobinhoodGateway(userId).getAccounts();
      // Prefer the account labeled "agentic". With only one eligible account the choice is
      // unambiguous. With multiple, fall back is unsafe: every non-IRA brokerage is now
      // agenticAllowed by default (Robinhood MCP omits the flag), so picking the wrong
      // account could attach live trading to a read-only Investing account — fail closed.
      const agenticAccounts = accounts.filter((a) => a.agenticAllowed);
      const labelMatch = agenticAccounts.find((a) => a.label.toLowerCase().includes("agentic"));
      const agentic = labelMatch ?? (agenticAccounts.length === 1 ? agenticAccounts[0] : undefined);
      if (!agentic) {
        const msg =
          agenticAccounts.length > 1
            ? 'Multiple Robinhood accounts are eligible but none is labeled "Agentic". Nickname the correct account "Agentic" in the Robinhood app and try again.'
            : "No agentic-enabled Robinhood account found. Connect your Robinhood agentic account first.";
        return new NextResponse(msg, { status: 400 });
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

    // Alpaca (paper-api vs api) and the local Test broker. For Alpaca, Paper is
    // inferred from either the account number ("PA...") or API key ("PK...").
    if ((broker === "alpaca" || broker === "alpaca-mcp") && (!body.accountNumber || !body.accountNumber.trim())) {
      return new NextResponse("Account number is required for Alpaca", { status: 400 });
    }

    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    let environment: "paper" | "live" = "paper";
    if (broker === "tradier") {
      // Tradier has NO PK/PA-style credential prefix — each token is environment-scoped, so the
      // environment is an EXPLICIT selector (sandbox=paper / production=live), never inferred. A
      // single bearer token is required; no apiSecret, no forced accountNumber (probed/user-supplied).
      if (!apiKey) {
        return new NextResponse("Tradier access token is required", { status: 400 });
      }
      environment = body.environment === "live" ? "live" : "paper";
      // `environment` is the authority for the venue. Reject a baseUrl whose host doesn't match the
      // selected environment so a paper-labeled account can never be pointed at the live
      // api.tradier.com (or a live account at sandbox). The gateway also ignores a mismatched stored
      // baseUrl at read time; this rejects it at write time so the bad value never persists.
      if (typeof body.baseUrl === "string" && body.baseUrl.trim()) {
        const expectedHost = environment === "live" ? "api.tradier.com" : "sandbox.tradier.com";
        let host: string | undefined;
        try {
          host = new URL(body.baseUrl.trim()).host.toLowerCase();
        } catch {
          host = undefined;
        }
        if (host !== expectedHost) {
          return new NextResponse(
            `Tradier ${environment} accounts must use ${expectedHost}; the provided base URL host does not match the selected environment.`,
            { status: 400 }
          );
        }
      }
    } else if (broker === "alpaca" || broker === "alpaca-mcp") {
      environment = isAlpacaPaperCredential({ accountNumber: body.accountNumber, apiKey }) ? "paper" : "live";
    } else if (broker === "test") {
      environment = "paper";
    } else {
      environment = body.environment === "live" ? "live" : "paper";
    }

    const defaultLabel =
      broker === "test"
        ? TEST_ACCOUNT_LABEL
        : broker === "tradier"
          ? `Tradier ${environment === "paper" ? "Sandbox" : "Brokerage"}`
          : broker === "alpaca-mcp"
            ? `Alpaca MCP ${environment === "paper" ? "Paper" : "Brokerage"}`
            : `Alpaca ${environment === "paper" ? "Paper" : "Brokerage"}`;
    const existingTestAccount = broker === "test" ? listConnectedAccounts(userId).find((a) => a.broker === "test") : undefined;
    let accountNumber =
      broker === "test"
        ? TEST_ACCOUNT_NUMBER
        : typeof body.accountNumber === "string"
          ? body.accountNumber.trim() || undefined
          : undefined;

    const connectedAccountId = existingTestAccount?.id ?? body.id ?? crypto.randomUUID();
    const connectedAccountLabel = typeof body.label === "string" ? body.label.trim() || existingTestAccount?.label || defaultLabel : existingTestAccount?.label || defaultLabel;
    upsertConnectedAccount({
      id: connectedAccountId,
      userId,
      broker,
      environment,
      accountNumber,
      label: connectedAccountLabel,
      apiKey: apiKey || undefined,
      apiSecret: typeof body.apiSecret === "string" ? body.apiSecret.trim() || undefined : undefined,
      baseUrl: typeof body.baseUrl === "string" && body.baseUrl.trim()
        ? body.baseUrl.trim()
        : broker === "tradier"
          ? environment === "paper"
            ? "https://sandbox.tradier.com/v1"
            : "https://api.tradier.com/v1"
          : (broker === "alpaca" || broker === "alpaca-mcp")
            ? environment === "paper"
              ? "https://paper-api.alpaca.markets/v2"
              : "https://api.alpaca.markets"
            : undefined,
      taxationType: taxationType ?? existingTestAccount?.taxationType,
      isActive: body.isActive ?? existingTestAccount?.isActive ?? false
    });

    // Tradier: resolve the account number from the token's profile if not provided by the user.
    // This avoids the "No account selected" rejection in strategy.ts when the policy copies a
    // missing accountNumber from the connected-account row.
    if (broker === "tradier" && !accountNumber) {
      let ambiguousError: Error | undefined;
      try {
        const { getTradierGateway } = await import("@/lib/tradier");
        const gw = getTradierGateway(userId, connectedAccountId);
        const brokerAccounts = await gw.getAccounts();
        if (brokerAccounts.length > 1) {
          ambiguousError = new Error("Multiple Tradier accounts found in profile. You must explicitly provide the Account Number to connect.");
        } else if (brokerAccounts.length === 1 && brokerAccounts[0].accountNumber) {
          accountNumber = brokerAccounts[0].accountNumber;
          upsertConnectedAccount({
            id: connectedAccountId,
            userId,
            broker,
            environment,
            accountNumber,
            label: connectedAccountLabel,
            apiKey: apiKey || undefined,
            capabilities: brokerAccounts[0].capabilities,
            baseUrl: broker === "tradier"
              ? environment === "paper"
                ? "https://sandbox.tradier.com/v1"
                : "https://api.tradier.com/v1"
              : undefined,
            isActive: body.isActive ?? existingTestAccount?.isActive ?? false
          });
        }
      } catch {
        // Best-effort — the profile probe may fail (e.g. network blip) and the
        // account number stays undefined; the user can provide it on re-connect.
      }
      if (ambiguousError) throw ambiguousError;
    }

    return NextResponse.json({ ok: true, accountNumber, label: connectedAccountLabel });
  } catch (err) {
    return new NextResponse(err instanceof Error ? err.message : "Error", { status: 400 });
  }
}
