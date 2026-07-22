/// The native Sign in with Apple audience must exactly match the app target's
/// registered bundle identifier. A deployment override remains available for
/// staged Apple service identifiers, but blank values cannot break native auth.
export const NATIVE_APPLE_CLIENT_ID = "trade.socratic.app";

export function resolveAppleClientId(value = process.env.APPLE_CLIENT_ID): string {
  return value?.trim() || NATIVE_APPLE_CLIENT_ID;
}
