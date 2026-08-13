// POST /api/mobile/push/register   — register (or re-register) this device's APNs token
// DELETE /api/mobile/push/register — unregister it (sign-out)
//
// Session-authenticated exactly like every other /api/mobile route: identity comes from
// resolveRequestUserId (middleware-verified), never from the body.
//
// Contract
//   POST   body { token: string, environment: "sandbox" | "production", bundleId?: string }
//          -> 200 { ok: true, device: { token: "<masked>", environment, bundleId, platform } }
//          Idempotent: re-POSTing the same token refreshes it and returns 200 again. Registering a
//          token that currently belongs to ANOTHER user REASSIGNS it to the caller — a shared phone
//          that switches accounts must never keep receiving the previous user's alerts.
//          Registering also enables the "apns" delivery channel for the user (the act of allowing
//          notifications in the app IS the opt-in); the user can still turn it off in
//          Settings -> Delivery, and turning it off is respected on the next send.
//   DELETE body { token: string }
//          -> 200 { ok: true, removed: boolean }
//          Scoped to the caller: a token owned by someone else is never touched (removed: false).
//
// The raw device token is never echoed back or logged — only maskDeviceToken form.

import {
  countActiveDeviceTokens,
  getNotifyPrefs,
  isApnsEnvironment,
  maskDeviceToken,
  normalizeDeviceToken,
  registerDeviceToken,
  setNotifyPrefs,
  unregisterDeviceToken
} from "@/lib/db";
import { loadApnsConfig } from "@/lib/apns";
import { enforceRateLimit } from "@/lib/rate-limit";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    token?: unknown;
    environment?: unknown;
    bundleId?: unknown;
    platform?: unknown;
  };
  const userId = resolveRequestUserId(request);
  const limited = enforceRateLimit(userId, "mobile/push/register", { limit: 30, windowMs: 60_000 });
  if (limited) return limited;

  const token = normalizeDeviceToken(body.token);
  if (!token) {
    return NextResponse.json({ ok: false, error: "token is required and must be a hex APNs device token" }, { status: 400 });
  }
  if (!isApnsEnvironment(body.environment)) {
    return NextResponse.json(
      { ok: false, error: 'environment is required and must be "sandbox" or "production"' },
      { status: 400 }
    );
  }

  // The bundle id doubles as the APNs topic. Default to the configured one; reject a mismatch
  // rather than storing a token we could never successfully push to.
  const configured = loadApnsConfig()?.bundleId ?? "";
  const suppliedBundleId = typeof body.bundleId === "string" ? body.bundleId.trim() : "";
  if (suppliedBundleId && configured && suppliedBundleId !== configured) {
    return NextResponse.json({ ok: false, error: "bundleId does not match this server's APNs topic" }, { status: 400 });
  }
  const bundleId = suppliedBundleId || configured;
  if (!bundleId) {
    return NextResponse.json({ ok: false, error: "bundleId is required (this server has no APNs topic configured)" }, { status: 400 });
  }

  const platform = typeof body.platform === "string" && body.platform.trim() ? body.platform.trim() : "ios";
  const device = registerDeviceToken({ userId, token, environment: body.environment, bundleId, platform });

  // Allowing notifications on the device IS the opt-in for the channel. Idempotent.
  const prefs = getNotifyPrefs(userId);
  if (!prefs.channels.includes("apns")) {
    setNotifyPrefs(userId, { channels: [...prefs.channels, "apns"] });
  }

  return NextResponse.json({
    ok: true,
    device: {
      token: maskDeviceToken(device.token),
      environment: device.environment,
      bundleId: device.bundleId,
      platform: device.platform,
      createdAt: device.createdAt,
      lastSeenAt: device.lastSeenAt
    }
  });
}

export async function DELETE(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { token?: unknown };
  const userId = resolveRequestUserId(request);
  const limited = enforceRateLimit(userId, "mobile/push/register", { limit: 30, windowMs: 60_000 });
  if (limited) return limited;

  const token = normalizeDeviceToken(body.token);
  if (!token) {
    return NextResponse.json({ ok: false, error: "token is required and must be a hex APNs device token" }, { status: 400 });
  }

  const removed = unregisterDeviceToken(userId, token);

  // Last device gone -> drop the channel too, so the user isn't left with an enabled channel that
  // has nowhere to deliver. Re-registering re-enables it.
  if (removed && countActiveDeviceTokens(userId) === 0) {
    const prefs = getNotifyPrefs(userId);
    if (prefs.channels.includes("apns")) {
      setNotifyPrefs(userId, { channels: prefs.channels.filter((channel) => channel !== "apns") });
    }
  }

  return NextResponse.json({ ok: true, removed });
}
