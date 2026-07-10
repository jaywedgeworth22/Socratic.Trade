import { describe, expect, it } from "vitest";
import { redTeamFailureMeta, redTeamFailureModel, type RedTeamVerdict } from "../app/console/lib/red-team";

function verdict(overrides: Partial<RedTeamVerdict>): RedTeamVerdict {
  return { rejected: false, available: false, reason: "Red Team evaluation failed.", ...overrides };
}

describe("redTeamFailureMeta", () => {
  it("matches the server-side describeRedTeamFailureKind wording for every kind", () => {
    expect(redTeamFailureMeta("not_configured").label).toBe("not configured");
    expect(redTeamFailureMeta("timeout").label).toBe("timeout");
    expect(redTeamFailureMeta("provider_error").label).toBe("provider error");
    expect(redTeamFailureMeta("rate_limited").label).toBe("rate limited");
    expect(redTeamFailureMeta("malformed_response").label).toBe("malformed response");
    expect(redTeamFailureMeta(undefined).label).toBe("unavailable");
  });

  it("always carries a plain-English hover explanation", () => {
    for (const kind of ["not_configured", "timeout", "provider_error", "rate_limited", "malformed_response", undefined] as const) {
      expect(redTeamFailureMeta(kind).title.length).toBeGreaterThan(20);
    }
  });
});

describe("redTeamFailureModel (never blame a model that provably never ran)", () => {
  it("prefers the persisted verdict model", () => {
    expect(redTeamFailureModel(verdict({ model: "deepseek-reasoner", failureKind: "timeout" }), "gpt-5.4-mini")).toBe("deepseek-reasoner");
  });

  it("returns null for not_configured even when a policy model exists — no model was ever called", () => {
    expect(redTeamFailureModel(verdict({ failureKind: "not_configured" }), "gpt-5.4-mini")).toBeNull();
  });

  it("falls back to the configured red-team model for runtime failures without a persisted model", () => {
    expect(redTeamFailureModel(verdict({ failureKind: "provider_error" }), "claude-haiku-4-5")).toBe("claude-haiku-4-5");
  });

  it("returns null when nothing is known", () => {
    expect(redTeamFailureModel(verdict({ failureKind: "provider_error" }), undefined)).toBeNull();
    expect(redTeamFailureModel(verdict({ failureKind: "provider_error" }), "   ")).toBeNull();
  });

  it("never displays the '__rotate__' rotation sentinel as the failed reviewer", () => {
    // A rotating policy's configured value is a rotation marker, not a model that ran — the
    // fallback must skip it (a persisted concrete pick on the verdict still wins as usual).
    expect(redTeamFailureModel(verdict({ failureKind: "provider_error" }), "__rotate__")).toBeNull();
    expect(redTeamFailureModel(verdict({ model: "gpt-5.4-mini", failureKind: "timeout" }), "__rotate__")).toBe("gpt-5.4-mini");
  });
});
