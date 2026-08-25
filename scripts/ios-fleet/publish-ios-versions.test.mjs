import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "scripts/ios-fleet/publish-ios-versions.sh");

const FLEET = {
  schemaVersion: 1,
  updatedAt: "2026-08-24T07:44:52Z",
  apps: {
    "trade.socratic.app": {
      displayName: "Socratic.Trade",
      marketingVersion: "1.0.68",
      appleId: 6799238379,
    },
    "trade.congress.ios": {
      displayName: "Congress.Trade",
      marketingVersion: "1.0.80",
      appleId: 6798076688,
    },
    "services.jays.usage.client.monitor": {
      displayName: "Usage Client Monitor",
      marketingVersion: "1.0.11",
      appleId: 6799230435,
      build: "202608231801",
    },
    "services.jays.usage.local.monitor": {
      displayName: "Usage Local Monitor",
      marketingVersion: "1.0.9",
      appleId: 6799230729,
      build: "202608231806",
    },
    "online.dealdex": {
      displayName: "DealDex",
      marketingVersion: "1.0.1",
      appleId: 6802474288,
    },
    "codes.autorotate": {
      displayName: "Autorotate",
      marketingVersion: "1.0.4",
      build: "202608240741",
    },
    "net.dealdex": {
      marketingVersion: "1.0.2",
      build: "202608230250",
      appleId: 6802474288,
      displayName: "DealDex",
    },
  },
};

function run(args) {
  return spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8" });
}

test("merge onto a multi-app remote keeps every sibling", () => {
  const dir = mkdtempSync(join(tmpdir(), "st-ios-versions-"));
  const base = join(dir, "remote.json");
  const out = join(dir, "out.json");
  writeFileSync(base, JSON.stringify(FLEET, null, 2) + "\n");
  const res = run([
    "--bundle-id",
    "trade.socratic.app",
    "--version",
    "1.0.69",
    "--build",
    "202608250045",
    "--apple-id",
    "6799238379",
    "--display-name",
    "Socratic.Trade",
    "--base-json",
    base,
    "--out-json",
    out,
    "--skip-push",
    "--skip-local-write",
  ]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const merged = JSON.parse(readFileSync(out, "utf8"));
  assert.deepEqual(Object.keys(merged.apps).sort(), Object.keys(FLEET.apps).sort());
  assert.equal(merged.apps["trade.socratic.app"].marketingVersion, "1.0.69");
  assert.equal(merged.apps["trade.socratic.app"].build, "202608250045");
  assert.equal(merged.apps["net.dealdex"].marketingVersion, "1.0.2");
  assert.equal(merged.apps["services.jays.usage.client.monitor"].marketingVersion, "1.0.11");
  assert.equal(merged.apps["services.jays.usage.local.monitor"].marketingVersion, "1.0.9");
  assert.equal(merged.apps["codes.autorotate"].marketingVersion, "1.0.4");
  rmSync(dir, { recursive: true, force: true });
});

test("empty base is refused so a missing local file cannot wipe the fleet", () => {
  const dir = mkdtempSync(join(tmpdir(), "st-ios-versions-empty-"));
  const base = join(dir, "empty.json");
  const out = join(dir, "out.json");
  writeFileSync(base, JSON.stringify({ schemaVersion: 1, apps: {} }, null, 2) + "\n");
  const res = run([
    "--bundle-id",
    "trade.socratic.app",
    "--version",
    "1.0.69",
    "--base-json",
    base,
    "--out-json",
    out,
    "--skip-push",
    "--skip-local-write",
  ]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /no apps|refusing/i);
  rmSync(dir, { recursive: true, force: true });
});

test("stale in-repo snapshot would drop net.dealdex and roll siblings", () => {
  const stale = JSON.parse(
    readFileSync(join(ROOT, "scripts/ios-fleet/ios-app-versions.json"), "utf8"),
  );
  assert.ok(!stale.apps["net.dealdex"], "vendored snapshot must stay the failing fixture");
  assert.equal(stale.apps["services.jays.usage.client.monitor"].marketingVersion, "1.0.8");
  assert.equal(stale.apps["services.jays.usage.local.monitor"].marketingVersion, "1.0.7");
  assert.equal(stale.apps["codes.autorotate"].marketingVersion, "1.0.1");
});

test("publish script fetches remote and refuses an empty apps map", () => {
  const src = readFileSync(SCRIPT, "utf8");
  assert.match(src, /fetch_remote_json/);
  assert.match(src, /refusing to publish an empty apps map/);
  assert.match(src, /--skip-push/);
  assert.doesNotMatch(src, /data = \{"schemaVersion": 1, "apps": \{\}\}/);
});
