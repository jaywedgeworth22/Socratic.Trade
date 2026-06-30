/**
 * Recursively delete keys whose value is `null` from a policy object (in place), so a client clearing an
 * optional field (sent as `null` to survive JSON) becomes an absent key, meaning the guard is off/default.
 * Skips arrays (for example permittedOrderTypes and enabledEvents never carry intentional nulls).
 */
export function stripNullsDeep(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (value === null) delete obj[key];
    else if (typeof value === "object" && !Array.isArray(value)) stripNullsDeep(value as Record<string, unknown>);
  }
}
