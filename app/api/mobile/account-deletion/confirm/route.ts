import { ACCOUNT_DELETE_PHRASE, LOCAL_OPERATOR_DELETE_PHRASE, confirmAndDeleteAccount } from "@/lib/account-deletion";
import { resolveRequestUser } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = resolveRequestUser(request);
  const body = (await request.json().catch(() => ({}))) as {
    typedText?: unknown;
    typedIdentity?: unknown;
  };
  const typedIdentity = typeof body.typedIdentity === "string" ? body.typedIdentity.trim().toLowerCase() : "";
  const expectedIdentity = (user.email ?? user.userId).trim().toLowerCase();
  if (typedIdentity !== expectedIdentity) {
    return NextResponse.json({ error: user.email ? "Signed-in email did not match." : "App user id did not match." }, { status: 400 });
  }
  if (String(body.typedText ?? "").trim() !== ACCOUNT_DELETE_PHRASE) {
    return NextResponse.json({ error: `Type ${ACCOUNT_DELETE_PHRASE} exactly to delete this account.` }, { status: 400 });
  }

  try {
    return NextResponse.json(
      await confirmAndDeleteAccount({
        userId: user.userId,
        email: user.email,
        body: {
          typedEmail: user.email,
          typedPhrase: ACCOUNT_DELETE_PHRASE,
          deleteAppData: true,
          deleteBrokerConnections: true,
          understandBrokerPositionsRemain: true,
          understandProviderRevocation: true,
          understandCanSignInAgain: true,
          ...(user.userId === "local"
            ? {
                confirmLocalOperator: true,
                localOperatorPhrase: LOCAL_OPERATOR_DELETE_PHRASE
              }
            : {})
        }
      })
    );
  } catch (error) {
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 400;
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Could not delete account.",
        blockers: (error as { blockers?: unknown }).blockers
      },
      { status }
    );
  }
}
