#!/usr/bin/env node

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const action = process.argv[2] || "dry-run";
const dbPath = process.env.LITESTREAM_DB_PATH || "data/app.db";
const replicaUrl = process.env.LITESTREAM_REPLICA_URL;

if (!["replicate", "restore", "dry-run"].includes(action)) {
  console.error("Usage: node scripts/litestream.mjs <replicate|restore|dry-run>");
  process.exit(2);
}

const probe = spawnSync("litestream", ["version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
if (probe.error?.code === "ENOENT") {
  console.error("Litestream is not installed or is not on PATH.");
  process.exit(127);
}

if (!replicaUrl) {
  console.error("Set LITESTREAM_REPLICA_URL before running Litestream commands.");
  process.exit(2);
}

mkdirSync(dirname(resolve(dbPath)), { recursive: true });

const args =
  action === "replicate"
    ? ["replicate", dbPath, replicaUrl]
    : action === "restore"
      ? ["restore", "-if-replica-exists", "-if-db-not-exists", "-o", dbPath, replicaUrl]
      : ["restore", "-dry-run", "-o", dbPath, replicaUrl];

const child = spawn("litestream", args, { stdio: "inherit" });

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
