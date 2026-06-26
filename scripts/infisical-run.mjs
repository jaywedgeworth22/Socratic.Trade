#!/usr/bin/env node
// Launches a command with secrets injected from Infisical, then propagates the
// child's exit code. Sets SECRETS_SOURCE=infisical (read by the REQUIRE_SECRETS_MANAGER
// boot guard, src/lib/secrets-source.ts).
//
// Auth (per project): prefer a machine-identity **Client ID + Client Secret**
// (universal auth — the long-lived credential). A Client Secret is NOT an access
// token: we exchange the Client ID + Secret for a short-lived access token via
// `infisical login --method=universal-auth … --plain` and pass it to the CLI as
// INFISICAL_TOKEN (the documented machine-identity flow; the CLI's run/export read
// INFISICAL_TOKEN, so we resolve to a concrete token rather than relying on env-var
// auto-auth). A pre-minted INFISICAL_TOKEN is accepted as a fallback.
//
// Two modes:
//   • Single project (default): `infisical run --projectId $INFISICAL_PROJECT_ID …`.
//   • App + shared overlay: when INFISICAL_SHARED_PROJECT_ID is set, fetch BOTH the
//     shared project and the app project with `infisical export` and merge them
//     ourselves so precedence is deterministic — **the app project wins** on any key
//     present in both (shared is the fallback). Each project authenticates with its
//     own machine identity.
//
// Env:
//   App project:    INFISICAL_PROJECT_ID
//                   INFISICAL_CLIENT_ID + INFISICAL_CLIENT_SECRET   (preferred)
//                   …or INFISICAL_TOKEN                             (fallback; expires)
//   Shared project: INFISICAL_SHARED_PROJECT_ID                     (enables the overlay)
//                   INFISICAL_SHARED_CLIENT_ID + INFISICAL_SHARED_CLIENT_SECRET
//                   …or INFISICAL_SHARED_TOKEN  (else falls back to the app identity)
//   INFISICAL_ENV (def NODE_ENV|dev) / INFISICAL_PATH (def /)
//   INFISICAL_SHARED_ENV (def INFISICAL_ENV) / INFISICAL_SHARED_PATH (def INFISICAL_PATH)
//   INFISICAL_WATCH=true                              single-project mode only
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

// Per-project credentials. The shared identity is distinct from the app's, so we
// only borrow the app identity when no shared-specific credential is supplied.
const appAuth = {
  clientId: process.env.INFISICAL_CLIENT_ID,
  clientSecret: process.env.INFISICAL_CLIENT_SECRET,
  token: process.env.INFISICAL_TOKEN,
};
const sharedAuthOwn = {
  clientId: process.env.INFISICAL_SHARED_CLIENT_ID,
  clientSecret: process.env.INFISICAL_SHARED_CLIENT_SECRET,
  token: process.env.INFISICAL_SHARED_TOKEN,
};

function hasAuth(a) {
  return Boolean((a.clientId && a.clientSecret) || a.token);
}

// Fail closed on a half-configured universal-auth pair (one of id/secret without the
// other) — don't silently fall back to a stale token or a cached CLI login while still
// marking SECRETS_SOURCE=infisical.
function assertCompletePair(a, label) {
  if (Boolean(a.clientId) !== Boolean(a.clientSecret)) {
    const p = label === "shared" ? "_SHARED" : "";
    console.error(
      `[infisical] Partial ${label} universal-auth credentials: set BOTH ` +
      `INFISICAL${p}_CLIENT_ID and INFISICAL${p}_CLIENT_SECRET (or neither).`
    );
    process.exit(2);
  }
}
assertCompletePair(appAuth, "app");
if (sharedProjectId) assertCompletePair(sharedAuthOwn, "shared");

// Exchange a machine-identity Client ID + Client Secret for a short-lived access
// token (universal auth). `--plain --silent` prints just the raw token. The creds
// are passed via the child ENV (INFISICAL_UNIVERSAL_AUTH_CLIENT_ID/SECRET), NOT on
// argv, so the long-lived Client Secret never appears in `ps`/`/proc/<pid>/cmdline`.
function mintToken(clientId, clientSecret, label) {
  const r = spawnSync(
    "infisical",
    ["login", "--method=universal-auth", "--silent", "--plain"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: clientId,
        INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: clientSecret,
        INFISICAL_DISABLE_UPDATE_CHECK: "true",
      },
    }
  );
  if (r.error) {
    console.error(`[infisical] failed to run 'infisical login' for the ${label} identity:`, r.error.message);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(
      `[infisical] universal-auth login failed for the ${label} identity (exit ${r.status}). ` +
      `Check the Client ID + Client Secret pairing/access:`, (r.stderr || "").trim()
    );
    process.exit(r.status || 1);
  }
  const token = (r.stdout || "").trim();
  if (!token) {
    console.error(`[infisical] universal-auth login for the ${label} identity returned an empty token.`);
    process.exit(1);
  }
  return token;
}

// A usable access token for an identity: Client ID + Secret (minted) wins so a stale
// INFISICAL_TOKEN can't take precedence; otherwise a pre-supplied token; else null
// (let the CLI fall back to a stored `infisical login` session, e.g. local dev).
function resolveToken(a, label) {
  if (a.clientId && a.clientSecret) return mintToken(a.clientId, a.clientSecret, label);
  if (a.token) return a.token;
  return null;
}

// Build a child/CLI env that authenticates purely via the resolved token, and never
// leaks the machine-identity Client Secret(s) into the spawned process.
function childEnv(extra, token) {
  const env = { ...process.env, ...extra };
  for (const k of [
    "INFISICAL_CLIENT_ID", "INFISICAL_CLIENT_SECRET",
    "INFISICAL_SHARED_CLIENT_ID", "INFISICAL_SHARED_CLIENT_SECRET", "INFISICAL_SHARED_TOKEN",
    "INFISICAL_UNIVERSAL_AUTH_CLIENT_ID", "INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET",
  ]) delete env[k];
  if (token) env.INFISICAL_TOKEN = token; else delete env.INFISICAL_TOKEN;
  env.INFISICAL_DISABLE_UPDATE_CHECK = env.INFISICAL_DISABLE_UPDATE_CHECK || "true";
  return env;
}

function runChild(env) {
  const child = spawn(command[0], command.slice(1), { stdio: "inherit", env });
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
  const appToken = resolveToken(appAuth, "app");
  const infisicalArgs = ["run", "--env", envName, "--path", secretsPath];
  if (appProjectId) infisicalArgs.push("--projectId", appProjectId);
  if (process.env.INFISICAL_WATCH === "true") infisicalArgs.push("--watch");
  infisicalArgs.push("--", ...command);
  // Marks that secrets came from a manager (read by the REQUIRE_SECRETS_MANAGER boot guard).
  const env = childEnv({ SECRETS_SOURCE: "infisical" }, appToken);
  const child = spawn("infisical", infisicalArgs, { stdio: "inherit", env });
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
  const sharedAuth = hasAuth(sharedAuthOwn) ? sharedAuthOwn : appAuth;
  const sharedEnv = process.env.INFISICAL_SHARED_ENV || envName;
  const sharedPath = process.env.INFISICAL_SHARED_PATH || secretsPath;

  const appToken = resolveToken(appAuth, "app");
  const sharedToken = resolveToken(sharedAuth, "shared");

  const sharedSecrets = fetchProject(sharedProjectId, sharedToken, sharedEnv, sharedPath, "shared");
  const appSecrets = fetchProject(appProjectId, appToken, envName, secretsPath, "app");

  // Precedence: process env < shared < app. The app project overrides shared on
  // any shared key, so an app-specific value always wins; shared-only keys fall
  // through. Counts only — values are never logged.
  const merged = { ...childEnv({}, appToken), ...sharedSecrets, ...appSecrets, SECRETS_SOURCE: "infisical" };
  const overlap = Object.keys(appSecrets).filter((k) => k in sharedSecrets).length;
  console.log(
    `[infisical] merged ${Object.keys(sharedSecrets).length} shared (${sharedProjectId}) + ` +
    `${Object.keys(appSecrets).length} app (${appProjectId}) secret(s); app wins ${overlap} overlap(s).`
  );
  runChild(merged);
}

function fetchProject(projectId, token, env, path, label) {
  if (!token) {
    const p = label === "shared" ? "_SHARED" : "";
    console.error(
      `[infisical] No credentials for the ${label} project ${projectId}. ` +
      `Set INFISICAL${p}_CLIENT_ID + INFISICAL${p}_CLIENT_SECRET (or INFISICAL${p}_TOKEN).`
    );
    process.exit(2);
  }
  // childEnv strips every client secret / universal-auth var so the export subprocess
  // authenticates with only the short-lived token — same scoping as the app launch.
  const spawnEnv = childEnv({}, token);
  const r = spawnSync(
    "infisical",
    ["export", "--projectId", projectId, "--env", env, "--path", path, "--format", "dotenv"],
    { encoding: "utf8", env: spawnEnv }
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
