import { ACCOUNT_DELETE_PHRASE, getAccountDeletionPreview, prepareAccountDeletion } from "@/lib/account-deletion";
import { resolveRequestUser } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function mobileDeletionRequest(user: { userId: string; email?: string }) {
  const preview = getAccountDeletionPreview(user);
  if (!preview.prepared) return null;
  return {
    requestId: preview.requestedAt ?? user.userId,
    userId: user.userId,
    email: user.email,
    requiredText: ACCOUNT_DELETE_PHRASE,
    steps: [
      "Review that backend account data, broker connections, provider keys, proposals, fills, watchlists, alerts, learned context, and normal audit events will be deleted for this app user.",
      user.email ? `Type your signed-in email: ${user.email}` : `Type your app user id: ${user.userId}`,
      `Type the exact phrase: ${ACCOUNT_DELETE_PHRASE}`,
      "Confirm deletion and sign out. Signing in later with the same provider creates a fresh app account.",
      "Optional: revoke this app in your provider account security settings if you also want to remove the provider-side OAuth grant."
    ]
  };
}

export async function GET(request: Request) {
  const user = resolveRequestUser(request);
  return NextResponse.json({ deletionRequest: mobileDeletionRequest(user) });
}

export async function POST(request: Request) {
  const user = resolveRequestUser(request);
  prepareAccountDeletion(user);
  return NextResponse.json({ deletionRequest: mobileDeletionRequest(user) }, { status: 201 });
}
