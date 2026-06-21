import { resolveRequestUserId } from "@/lib/request-user";
import { appendTurn, clearTurns, listTurns } from "@/lib/chat-history";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const userId = resolveRequestUserId(request);
  const limit = Number(new URL(request.url).searchParams.get("limit") ?? "100");
  return NextResponse.json({ turns: listTurns(userId, limit) });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    role?: unknown;
    text?: unknown;
    citations?: unknown;
    intent?: unknown;
    userId?: unknown;
  };
  const userId = resolveRequestUserId(request, body);
  if (body.role !== "user" && body.role !== "assistant") {
    return NextResponse.json({ error: "role must be 'user' or 'assistant'" }, { status: 400 });
  }
  if (typeof body.text !== "string") {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }
  const turn = appendTurn(userId, {
    role: body.role,
    text: body.text,
    citations: Array.isArray(body.citations) ? body.citations.filter((c): c is string => typeof c === "string") : [],
    intent: typeof body.intent === "string" ? body.intent : null
  });
  return NextResponse.json({ turn }, { status: 201 });
}

export async function DELETE(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { userId?: unknown };
  const userId = resolveRequestUserId(request, body);
  return NextResponse.json({ cleared: clearTurns(userId) });
}
