#!/usr/bin/env node
// Fetches secrets from Google Cloud Secret Manager and injects them as env vars,
// then exec's the given command. Mirrors the infisical-run.mjs pattern.
//
// Fail-open by design: any error in the Secret Manager path (missing/invalid
// GOOGLE_APPLICATION_CREDENTIALS, no ADC, IAM/permission/network failure, …)
// logs a warning and still runs the command with the existing environment,
// rather than crashing. The command runs exactly once and the wrapper always
// propagates the child's exit code.
//
// Prerequisites:
//   npm install @google-cloud/secret-manager
//   Set GCP_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) to your GCP project.
//   Authenticate via one of:
//     - GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account-key.json
//     - gcloud auth application-default login (local dev)
//     - Workload Identity / metadata server (GCP-hosted envs)
//
// Secret naming convention: each GCP secret whose name matches an env var name
// (e.g. INTRINIO_API_KEY) will be fetched and injected. Configure via:
//   GCP_SECRET_NAMES=COMMA,SEPARATED,LIST   (explicit list)
//   GCP_SECRETS_PREFIX=trading-             (prefix filter when listing all)
//   GCP_SECRETS_OVERWRITE=true              (overwrite env vars already set)
//
// Usage:
//   node scripts/gcp-secrets-run.mjs -- npm run dev
//   node scripts/gcp-secrets-run.mjs -- npm run build
//   node scripts/gcp-secrets-run.mjs -- npm run start

import { spawn } from "node:child_process";

const separatorIndex = process.argv.indexOf("--");
const command = separatorIndex >= 0 ? process.argv.slice(separatorIndex + 1) : process.argv.slice(2);

if (command.length === 0) {
  console.error("Usage: node scripts/gcp-secrets-run.mjs -- <command...>");
  process.exit(2);
}

const projectId = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
const injected = { ...process.env };

// Run the wrapped command exactly once. Both the normal path and the fail-open
// error handlers below funnel through here, so the child can never be spawned
// twice, and the wrapper always exits with the child's exit code.
let started = false;
function runCommand() {
  if (started) return;
  started = true;
  const child = spawn(command[0], command.slice(1), {
    stdio: "inherit",
    env: { ...injected, GCP_SECRETS_DISABLE_UPDATE_CHECK: "true" },
    shell: false,
  });
  child.on("error", (err) => {
    console.error("[gcp-secrets] Failed to start command:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) { process.kill(process.pid, signal); return; }
    process.exit(code ?? 1);
  });
}

// Fail open: a credential/SDK error in the Secret Manager path must never crash
// the wrapper. Some auth failures (bad GOOGLE_APPLICATION_CREDENTIALS, missing
// ADC, malformed key file) surface as an uncaught exception / unhandled
// rejection from deep inside the client, so guard at the process level and fall
// back to running the command with the existing environment. The `started`
// guard makes this a no-op once the command is already running.
function failOpen(err) {
  if (started) return;
  console.error("[gcp-secrets] Secret Manager unavailable:", err instanceof Error ? err.message : err);
  console.warn("[gcp-secrets] Falling back to running command without GCP secrets.");
  runCommand();
}
process.on("uncaughtException", failOpen);
process.on("unhandledRejection", failOpen);

if (!projectId) {
  console.warn("[gcp-secrets] GCP_PROJECT_ID not set — skipping Secret Manager, running command directly.");
} else {
  // Check @google-cloud/secret-manager is installed
  let SecretManagerServiceClient;
  try {
    ({ SecretManagerServiceClient } = await import("@google-cloud/secret-manager"));
  } catch {
    console.error("[gcp-secrets] @google-cloud/secret-manager is not installed. Run: npm install @google-cloud/secret-manager");
    process.exit(1);
  }

  const overwrite = ["1", "true", "yes", "on"].includes(String(process.env.GCP_SECRETS_OVERWRITE ?? "").toLowerCase());
  const prefix = process.env.GCP_SECRETS_PREFIX ?? "";

  try {
    const client = new SecretManagerServiceClient();
    let secretNames;

    if (process.env.GCP_SECRET_NAMES) {
      // Explicit list: GCP_SECRET_NAMES=INTRINIO_API_KEY,TIINGO_API_KEY,...
      secretNames = process.env.GCP_SECRET_NAMES.split(",").map((s) => s.trim()).filter(Boolean);
    } else {
      // List all secrets in the project (optionally filtered by prefix).
      const [secrets] = await client.listSecrets({ parent: `projects/${projectId}` });
      secretNames = secrets
        .map((s) => s.name?.split("/").pop() ?? "")
        .filter((name) => name && name.startsWith(prefix));
    }

    console.log(`[gcp-secrets] Fetching ${secretNames.length} secret(s) from project ${projectId}`);

    await Promise.all(
      secretNames.map(async (secretName) => {
        const envKey = secretName.startsWith(prefix) ? secretName.slice(prefix.length) : secretName;
        if (!overwrite && injected[envKey]) return; // already set in environment
        try {
          const [version] = await client.accessSecretVersion({
            name: `projects/${projectId}/secrets/${secretName}/versions/latest`,
          });
          const value = version.payload?.data?.toString("utf8");
          if (value) {
            injected[envKey] = value;
            console.log(`[gcp-secrets] Loaded ${secretName} → ${envKey}`);
          }
        } catch (err) {
          console.warn(`[gcp-secrets] Could not fetch ${secretName}:`, err instanceof Error ? err.message : err);
        }
      })
    );
    // Mark a successful manager-sourced launch (read by the REQUIRE_SECRETS_MANAGER boot guard). Set
    // ONLY on success — a fail-open fallback below intentionally leaves it unset so the guard trips
    // rather than silently running on a local .env.local.
    injected.SECRETS_SOURCE = "gcp";
  } catch (err) {
    console.error("[gcp-secrets] Failed to access Secret Manager:", err instanceof Error ? err.message : err);
    console.warn("[gcp-secrets] Falling back to running command without GCP secrets.");
  }
}

// Run the command once, for every path above (configured, skip, or fail-open).
runCommand();
