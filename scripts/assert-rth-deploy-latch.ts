#!/usr/bin/env npx tsx
// Fail a Coolify image build when:
//   exit 2 = weekday US equity RTH without HOTFIX=1 / RTH_DEPLOY_OVERRIDE=1
//   exit 3 = docs-only / image-noop (would not change the running image)
// Exit 0 = allow the rebuild.  Exit 1 = usage error.
// Runs BEFORE npm ci so a no-op like #2811 dies in seconds, not ~30 minutes.
// Keep this at build time — never call it from coolify-prod-start.sh.

import { execSync } from "node:child_process";
import {
  decideRthDeployLatchFromEnv,
  describeRthDeployLatchDecision
} from "../src/lib/rth-deploy-latch";

function readGitLog(): string | undefined {
  try {
    const message = execSync("git log -1 --pretty=%B", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return message.trim() ? message : undefined;
  } catch {
    return undefined;
  }
}

const decision = await decideRthDeployLatchFromEnv(process.env, readGitLog);
const line = describeRthDeployLatchDecision(decision);
if (decision.allowed) {
  console.log(line);
  process.exit(0);
}
console.error(line);
process.exit(decision.reason === "image-noop" ? 3 : 2);
