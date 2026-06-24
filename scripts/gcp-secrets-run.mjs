#!/usr/bin/env node
// Fetches secrets from Google Cloud Secret Manager and injects them as env vars,
// then exec's the given command. Mirrors the infisical-run.mjs pattern.
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

import { spawn, spawnSync } from "node:child_process";

const separatorIndex = process.argv.indexOf("--");
const command = separatorIndex >= 0 ? process.argv.slice(separatorIndex + 1) : process.argv.slice(2);

if (command.length === 0) {
  console.error("Usage: node scripts/gcp-secrets-run.mjs -- <command...>");
  process.exit(2);
}

const projectId = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
if (!projectId) {
  console.warn("[gcp-secrets] GCP_PROJECT_ID not set — skipping Secret Manager, running command directly.");
  runCommand(command, process.env);
  process.exit(0);  // exit handled inside runCommand via event
}

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

const client = new SecretManagerServiceClient();
const injected = { ...process.env };

try {
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
} catch (err) {
  console.error("[gcp-secrets] Failed to access Secret Manager:", err instanceof Error ? err.message : err);
  console.warn("[gcp-secrets] Falling back to running command without GCP secrets.");
}

runCommand(command, injected);

function runCommand(cmd, env) {
  const child = spawn(cmd[0], cmd.slice(1), {
    stdio: "inherit",
    env: { ...env, GCP_SECRETS_DISABLE_UPDATE_CHECK: "true" },
    shell: false,
  });
  child.on("exit", (code, signal) => {
    if (signal) { process.kill(process.pid, signal); return; }
    process.exit(code ?? 1);
  });
}
