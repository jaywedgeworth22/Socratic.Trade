import { NextRequest, NextResponse } from "next/server";
import { listUserApiKeys, upsertUserApiKey, deleteUserApiKey, resolveApiKey } from "@/lib/db";

/**
 * Multi-user API Key Management
 *
 * Scaffolding for per-user API key storage. Currently uses a simple
 * userId query param (no auth). In production, this should be gated
 * behind proper authentication middleware.
 *
 * Supported services: "finnhub", "fmp", "openai"
 *
 * GET  /api/keys?userId=<id>           → list all keys for user
 * GET  /api/keys?userId=<id>&service=<s> → resolve key (user → env fallback)
 * POST /api/keys  { userId, service, apiKey, label? }  → upsert key
 * DELETE /api/keys?userId=<id>&service=<s>  → delete key
 */

const VALID_SERVICES = ["finnhub", "fmp", "openai"];

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const userId = searchParams.get("userId");

  if (!userId) {
    return NextResponse.json({ error: "userId query parameter is required" }, { status: 400 });
  }

  const service = searchParams.get("service");

  // If a specific service is requested, resolve the key (user DB → env fallback)
  if (service) {
    if (!VALID_SERVICES.includes(service.toLowerCase())) {
      return NextResponse.json({ error: `Invalid service. Must be one of: ${VALID_SERVICES.join(", ")}` }, { status: 400 });
    }
    const key = resolveApiKey(service, userId);
    return NextResponse.json({
      service,
      configured: Boolean(key),
      source: key ? "user" : "none"
      // NOTE: never return the actual key in a GET response for security
    });
  }

  // List all keys for the user (mask the actual key values)
  const keys = listUserApiKeys(userId);
  return NextResponse.json({
    keys: keys.map((k) => ({
      id: k.id,
      service: k.service,
      label: k.label,
      configured: true,
      createdAt: k.createdAt,
      updatedAt: k.updatedAt
    }))
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { userId?: string; service?: string; apiKey?: string; label?: string };
    const { userId, service, apiKey, label } = body;

    if (!userId || typeof userId !== "string") {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }
    if (!service || typeof service !== "string" || !VALID_SERVICES.includes(service.toLowerCase())) {
      return NextResponse.json({ error: `service is required and must be one of: ${VALID_SERVICES.join(", ")}` }, { status: 400 });
    }
    if (!apiKey || typeof apiKey !== "string" || apiKey.trim().length === 0) {
      return NextResponse.json({ error: "apiKey is required and must be a non-empty string" }, { status: 400 });
    }

    const result = upsertUserApiKey(userId, service.toLowerCase(), apiKey.trim(), label);
    return NextResponse.json({
      success: true,
      key: {
        id: result.id,
        service: result.service,
        label: result.label,
        createdAt: result.createdAt,
        updatedAt: result.updatedAt
      }
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to save API key" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const userId = searchParams.get("userId");
  const service = searchParams.get("service");

  if (!userId || !service) {
    return NextResponse.json({ error: "userId and service query parameters are required" }, { status: 400 });
  }

  if (!VALID_SERVICES.includes(service.toLowerCase())) {
    return NextResponse.json({ error: `Invalid service. Must be one of: ${VALID_SERVICES.join(", ")}` }, { status: 400 });
  }

  const deleted = deleteUserApiKey(userId, service.toLowerCase());
  return NextResponse.json({ success: true, deleted });
}
