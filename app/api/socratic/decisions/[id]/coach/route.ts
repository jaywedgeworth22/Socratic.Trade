import { attachSocraticDecisionCoachPrimitives } from "@/lib/db";
import type { SocraticFrameworkProposal } from "@/lib/types";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const body = await request.json().catch(() => ({}));
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (!note) return NextResponse.json({ error: "note is required" }, { status: 400 });
  if (note.length > 4000) return NextResponse.json({ error: "note must be 4000 characters or fewer" }, { status: 400 });
  const promoteTo = body.promoteTo === "lesson" || body.promoteTo === "framework" ? body.promoteTo : undefined;
  const framework = body.framework && typeof body.framework === "object" ? body.framework as Record<string, unknown> : undefined;
  const subsystem = framework?.subsystem;
  const priority = framework?.priority;
  const { id } = await context.params;
  const userId = resolveRequestUserId(request);
  const decision = await appendSocraticDecisionCoachNote(id, note, userId);
  if (!decision) return NextResponse.json({ error: "decision not found" }, { status: 404 });
  return NextResponse.json(decision);
}
