// Secrets-source marker + boot guard.
//
// The secrets-manager runner (scripts/infisical-run.mjs) injects `SECRETS_SOURCE` into the process
// env when it launches the app, recording that secrets came from a manager rather than a plain
// `.env.local`. When `REQUIRE_SECRETS_MANAGER` is set, the app refuses to boot unless that marker is
// present — so a credential can never silently be served from a committed/forgotten `.env.local` in a
// deployment that's supposed to source everything from Infisical. Default OFF → zero behavior change
// for local dev, tests, and CI.

export type SecretsSource = "infisical" | "env";

/** Which runner launched the app, or "env" when started plainly (no secrets manager). */
export function secretsSource(): SecretsSource {
  const raw = (process.env.SECRETS_SOURCE ?? "").trim().toLowerCase();
  if (raw === "infisical") return raw;
  return "env";
}

function isManagerRequired(): boolean {
  const v = (process.env.REQUIRE_SECRETS_MANAGER ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

/**
 * Returns a human-readable problem string when the secrets-manager requirement is violated, else
 * null. Pure (reads only env) so it's directly unit-testable.
 */
export function secretsManagerProblem(): string | null {
  if (!isManagerRequired()) return null;
  if (secretsSource() === "env") {
    return (
      "REQUIRE_SECRETS_MANAGER is set, but the app was NOT launched through a secrets-manager runner " +
      "(SECRETS_SOURCE is unset). Start it via `npm run start:secrets` (Infisical), " +
      "so secrets come from the manager and not a local .env.local. To intentionally disable this guard, " +
      "unset REQUIRE_SECRETS_MANAGER."
    );
  }
  return null;
}

/** Boot guard — throws when the secrets-manager requirement is violated. Call once at server start. */
export function assertSecretsManagerIfRequired(): void {
  const problem = secretsManagerProblem();
  if (problem) throw new Error(`[secrets] ${problem}`);
}
