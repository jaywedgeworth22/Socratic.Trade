import { appendSocraticDecisionCoachNote } from "@/lib/db";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const body = await request.json().catch(() => ({}));
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (!note) return NextResponse.json({ error: "note is required" }, { status: 400 });
  if (note.length > 4000) return NextResponse.json({ error: "note must be 4000 characters or fewer" }, { status: 400 });
  const { id } = await context.params;
  const userId = resolveRequestUserId(request);
  const decision = appendSocraticDecisionCoachNote(id, note, userId);
  if (!decision) return NextResponse.json({ error: "decision not found" }, { status: 404 });
  return NextResponse.json(decision);
}
