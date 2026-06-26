#!/usr/bin/env node
// Launches a command with secrets injected from Infisical, then propagates the
// child's exit code. Sets SECRETS_SOURCE=infisical (read by the REQUIRE_SECRETS_MANAGER
// boot guard, src/lib/secrets-source.ts).
//
// Two modes:
//   • Single project (default): `infisical run --projectId $INFISICAL_PROJECT_ID …`.
//   • App + shared overlay: when INFISICAL_SHARED_PROJECT_ID is set, fetch BOTH the
//     shared project and the app project with `infisical export` and merge them
//     ourselves so precedence is deterministic — **the app project wins** on any key
//     present in both (shared is the fallback). Each project authenticates with its
//     own machine-identity token.
//
// Env:
//   INFISICAL_PROJECT_ID / INFISICAL_TOKEN          app project + its identity token
//   INFISICAL_ENV (def NODE_ENV|dev) / INFISICAL_PATH (def /)
//   INFISICAL_SHARED_PROJECT_ID                      optional shared project (App-A/B)
//   INFISICAL_SHARED_TOKEN (def INFISICAL_TOKEN)     shared project's identity token
//   INFISICAL_SHARED_ENV (def INFISICAL_ENV) / INFISICAL_SHARED_PATH (def INFISICAL_PATH)
//   INFISICAL_WATCH=true                             single-project mode only
//
// Usage: node scripts/infisical-run.mjs -- npm run start

import { spawn, spawnSync } from "node:child_process";

const separatorIndex = process.argv.indexOf("--");
const command = separatorIndex >= 0 ? process.argv.slice(separatorIndex + 1) : process.argv.slice(2);

if (command.length === 0) {
  console.error("Usage: node scripts/infisical-run.mjs -- <command...>");
  process.exit(2);
}

const probe = spawnSync("infisical", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
if (probe.error?.code === "ENOENT") {
  console.error("Infisical CLI is not installed or is not on PATH. Install it, then rerun this command.");
  process.exit(127);
}

const envName = process.env.INFISICAL_ENV || process.env.NODE_ENV || "dev";
const secretsPath = process.env.INFISICAL_PATH || "/";
const appProjectId = process.env.INFISICAL_PROJECT_ID;
const sharedProjectId = process.env.INFISICAL_SHARED_PROJECT_ID;

function runChild(env) {
  const child = spawn(command[0], command.slice(1), {
    stdio: "inherit",
    env: { ...env, INFISICAL_DISABLE_UPDATE_CHECK: env.INFISICAL_DISABLE_UPDATE_CHECK || "true" },
  });
  child.on("error", (err) => {
    console.error("[infisical] Failed to start command:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) { process.kill(process.pid, signal); return; }
    process.exit(code ?? 1);
  });
}

if (!sharedProjectId) {
  // ── Single project: the proven `infisical run` path (supports --watch) ──────
  const infisicalArgs = ["run", "--env", envName, "--path", secretsPath];
  if (appProjectId) infisicalArgs.push("--projectId", appProjectId);
  if (process.env.INFISICAL_WATCH === "true") infisicalArgs.push("--watch");
  infisicalArgs.push("--", ...command);
  const child = spawn("infisical", infisicalArgs, {
    stdio: "inherit",
    env: {
      ...process.env,
      INFISICAL_DISABLE_UPDATE_CHECK: process.env.INFISICAL_DISABLE_UPDATE_CHECK || "true",
      // Marks that secrets came from a manager (read by the REQUIRE_SECRETS_MANAGER boot guard).
      SECRETS_SOURCE: "infisical",
    },
  });
  child.on("exit", (code, signal) => {
    if (signal) { process.kill(process.pid, signal); return; }
    process.exit(code ?? 1);
  });
} else {
  // ── App + shared overlay: fetch both, merge with the APP winning ────────────
  if (!appProjectId) {
    console.error("[infisical] INFISICAL_SHARED_PROJECT_ID is set but INFISICAL_PROJECT_ID (the app project) is not.");
    process.exit(2);
  }
  const appToken = process.env.INFISICAL_TOKEN;
  const sharedToken = process.env.INFISICAL_SHARED_TOKEN || appToken;
  const sharedEnv = process.env.INFISICAL_SHARED_ENV || envName;
  const sharedPath = process.env.INFISICAL_SHARED_PATH || secretsPath;

  const sharedSecrets = fetchProject(sharedProjectId, sharedToken, sharedEnv, sharedPath);
  const appSecrets = fetchProject(appProjectId, appToken, envName, secretsPath);

  // Precedence: process env < shared < app. The app project overrides shared on
  // any shared key, so an app-specific value always wins; shared-only keys fall
  // through. Counts only — values are never logged.
  const merged = { ...process.env, ...sharedSecrets, ...appSecrets, SECRETS_SOURCE: "infisical" };
  const overlap = Object.keys(appSecrets).filter((k) => k in sharedSecrets).length;
  console.log(
    `[infisical] merged ${Object.keys(sharedSecrets).length} shared (${sharedProjectId}) + ` +
    `${Object.keys(appSecrets).length} app (${appProjectId}) secret(s); app wins ${overlap} overlap(s).`
  );
  runChild(merged);
}

function fetchProject(projectId, token, env, path) {
  if (!token) {
    console.error(`[infisical] No token for project ${projectId} (set INFISICAL_TOKEN / INFISICAL_SHARED_TOKEN).`);
    process.exit(2);
  }
  const r = spawnSync(
    "infisical",
    ["export", "--projectId", projectId, "--env", env, "--path", path, "--format", "dotenv"],
    { encoding: "utf8", env: { ...process.env, INFISICAL_TOKEN: token, INFISICAL_DISABLE_UPDATE_CHECK: "true" } }
  );
  if (r.error) {
    console.error(`[infisical] failed to run 'infisical export' for ${projectId}:`, r.error.message);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`[infisical] 'infisical export' failed for project ${projectId} (exit ${r.status}):`, (r.stderr || "").trim());
    process.exit(r.status || 1);
  }
  return parseDotenv(r.stdout || "");
}

function parseDotenv(text) {
  const out = {};
  for (let line of text.split("\n")) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2 && ((val[0] === "'" && val[val.length - 1] === "'") || (val[0] === '"' && val[val.length - 1] === '"'))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}
