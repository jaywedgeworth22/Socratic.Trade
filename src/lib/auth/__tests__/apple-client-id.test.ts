import { describe, expect, it } from "vitest";
import { NATIVE_APPLE_CLIENT_ID, resolveAppleClientIds } from "../apple-client-id";

describe("apple-client-id", () => {
  it("defaults to NATIVE_APPLE_CLIENT_ID when env is empty", () => {
    expect(resolveAppleClientIds(undefined)).toEqual([NATIVE_APPLE_CLIENT_ID]);
    expect(resolveAppleClientIds("   ")).toEqual([NATIVE_APPLE_CLIENT_ID]);
    expect(resolveAppleClientIds("")).toEqual([NATIVE_APPLE_CLIENT_ID]);
  });

  it("returns array with NATIVE_APPLE_CLIENT_ID and override when env is provided", () => {
    expect(resolveAppleClientIds("trade.override.web")).toEqual([NATIVE_APPLE_CLIENT_ID, "trade.override.web"]);
    expect(resolveAppleClientIds("  trade.override.web  ")).toEqual([NATIVE_APPLE_CLIENT_ID, "trade.override.web"]);
  });
});
