import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { recordRejectedProposalCounterfactual } from "../src/lib/counterfactual-learning";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-rejcf-${randomUUID()}.db`)}`;
});

describe("recordRejectedProposalCounterfactual", () => {
  it("inserts a pending counterfactual for a rejected proposal and is idempotent", async () => {
    const { getDb } = await import("../src/lib/db");
    const inserted = recordRejectedProposalCounterfactual({
      userId: "local",
      runId: "run-1",
      symbol: "AAPL",
      refPrice: 200,
      createdAt: "2026-06-20T15:00:00.000Z",
      regime: "Risk-On (Low Volatility)"
    });
    expect(inserted).toBe(true);

    const row = getDb()
      .prepare("SELECT symbol, ref_price, status, regime, horizon_days FROM skipped_candidate_counterfactuals WHERE user_id = ? AND run_id = ?")
      .get("local", "run-1") as { symbol: string; ref_price: number; status: string; regime: string; horizon_days: number } | undefined;
    expect(row).toBeTruthy();
    expect(row!.symbol).toBe("AAPL");
    expect(row!.ref_price).toBe(200);
    expect(row!.status).toBe("pending");
    expect(row!.regime).toBe("Risk-On (Low Volatility)");

    // INSERT OR IGNORE → a duplicate (same user/run/symbol/horizon) does not double-count.
    const again = recordRejectedProposalCounterfactual({
      userId: "local",
      runId: "run-1",
      symbol: "AAPL",
      refPrice: 200,
      createdAt: "2026-06-20T15:00:00.000Z"
    });
    expect(again).toBe(false);

    const count = getDb()
      .prepare("SELECT COUNT(*) AS n FROM skipped_candidate_counterfactuals WHERE user_id = ? AND run_id = ? AND symbol = ?")
      .get("local", "run-1", "AAPL") as { n: number };
    expect(count.n).toBe(1);
  });

  it("returns false without a usable reference price (no fabricated anchor)", () => {
    expect(recordRejectedProposalCounterfactual({ userId: "local", runId: "run-2", symbol: "MSFT", refPrice: undefined, createdAt: "2026-06-20T15:00:00.000Z" })).toBe(false);
    expect(recordRejectedProposalCounterfactual({ userId: "local", runId: "run-3", symbol: "MSFT", refPrice: 0, createdAt: "2026-06-20T15:00:00.000Z" })).toBe(false);
  });
});
