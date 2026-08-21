import { afterEach } from "vitest";
import { resetPeerLaneBackoffForTests } from "../src/lib/peer-lane-backoff";

// vitest maxWorkers is 1, so process-local peer-lane samples leak across files.
// This module is fetch-free and db-free — do not import congress/UM helpers here
// or setupFiles would open getDb() before a test file sets DATABASE_URL.
afterEach(() => {
  resetPeerLaneBackoffForTests();
});
