#!/usr/bin/env npx tsx
// Fail a Coolify image build during weekday US equity RTH unless HOTFIX=1
// or RTH_DEPLOY_OVERRIDE=1.  Exit 0 = allow, 2 = blocked, 1 = usage error.
// Invoked from the Dockerfile AFTER `COPY . .` and BEFORE `npm run build`.
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
process.exit(2);
