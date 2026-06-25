import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-tp-trim-${randomUUID()}.db`)}`;
});

describe("take_profit_trims ratchet persistence", () => {
  it("round-trips bands, upserts monotonically, and clears on close", async () => {
    const { getTakeProfitTrimBands, recordTakeProfitTrimBand, clearTakeProfitTrimBands } = await import("../src/lib/db");
    const acct = "ACCT1";

    expect(getTakeProfitTrimBands(acct)).toEqual({});

    recordTakeProfitTrimBand(acct, "NVDA", 1);
    recordTakeProfitTrimBand(acct, "AAPL", 2);
    expect(getTakeProfitTrimBands(acct)).toEqual({ NVDA: 1, AAPL: 2 });

    // Upsert advances the band for the same key (no duplicate row).
    recordTakeProfitTrimBand(acct, "NVDA", 3);
    expect(getTakeProfitTrimBands(acct)).toEqual({ NVDA: 3, AAPL: 2 });

    // Scoped per account.
    expect(getTakeProfitTrimBands("OTHER")).toEqual({});

    // Clear specific symbols (closed positions); empty input is a no-op.
    clearTakeProfitTrimBands(acct, []);
    expect(getTakeProfitTrimBands(acct)).toEqual({ NVDA: 3, AAPL: 2 });
    clearTakeProfitTrimBands(acct, ["NVDA"]);
    expect(getTakeProfitTrimBands(acct)).toEqual({ AAPL: 2 });
  });

  it("floors/clamps the stored band to a non-negative integer", async () => {
    const { getTakeProfitTrimBands, recordTakeProfitTrimBand } = await import("../src/lib/db");
    recordTakeProfitTrimBand("ACCT2", "MSFT", 2.9);
    expect(getTakeProfitTrimBands("ACCT2").MSFT).toBe(2);
  });
});
