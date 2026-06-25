#!/usr/bin/env node

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
const infisicalArgs = ["run", "--env", envName, "--path", secretsPath];

if (process.env.INFISICAL_PROJECT_ID) {
  infisicalArgs.push("--projectId", process.env.INFISICAL_PROJECT_ID);
}

if (process.env.INFISICAL_WATCH === "true") {
  infisicalArgs.push("--watch");
}

infisicalArgs.push("--", ...command);

const child = spawn("infisical", infisicalArgs, {
  stdio: "inherit",
  env: {
    ...process.env,
    INFISICAL_DISABLE_UPDATE_CHECK: process.env.INFISICAL_DISABLE_UPDATE_CHECK || "true",
    // Marks that secrets came from a manager (read by the REQUIRE_SECRETS_MANAGER boot guard).
    SECRETS_SOURCE: "infisical"
  }
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
