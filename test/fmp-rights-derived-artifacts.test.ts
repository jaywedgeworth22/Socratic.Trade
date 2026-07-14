import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const vectorMocks = vi.hoisted(() => ({
  getCurrentVectorProviderAuthority: vi.fn(async () => "provider:test"),
  managedVectorLedgerAuthority: vi.fn(() => "ledger:test"),
  vectorTenantScope: vi.fn(() => "shared:operator"),
  managedOccurrenceVectorPrefix: vi.fn(() => "occ:v3:test:"),
  managedOccurrenceVectorIdMatches: vi.fn(() => false),
  managedVectorReceiptEvidence: vi.fn(() => []),
  inventoryVectorRecordsByMetadata: vi.fn(async () => []),
  purgeVectorRecordsByMetadata: vi.fn(async () => ({ ids: [], deleted: 0 })),
  purgeVectorRecordIds: vi.fn(async ({ ids }: { ids: string[] }) => ({ ids, deleted: ids.length })),
  purgeVectorNamespaceAll: vi.fn(async () => undefined)
}));

vi.mock("../src/lib/vector-db", () => ({
  ...vectorMocks
}));

beforeAll(async () => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `socratic-fmp-rights-derived-${randomUUID()}.db`)}`;
  process.env.WEB_SOURCE_FMP_TRANSCRIPTS = "off";
  process.env.FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED = "on";
  const { getDb } = await import("../src/lib/db");
  getDb();
}, 60_000);

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.WEB_SOURCE_FMP_TRANSCRIPTS = "off";
  process.env.FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED = "on";
  const {
    activateFmpTranscriptRightsGeneration,
    captureFmpTranscriptRightsGeneration
  } = await import("../src/lib/web-sources/fmp-transcripts");
  const { getDb } = await import("../src/lib/db");
  const database = getDb();
  activateFmpTranscriptRightsGeneration();
  expect(captureFmpTranscriptRightsGeneration()).toBeDefined();
  database.prepare("DELETE FROM fmp_transcript_derived_provider_work").run();
  database.prepare("DELETE FROM fmp_transcript_derived_artifacts").run();
  database.prepare("DELETE FROM chat_turns WHERE id LIKE 'fmp-rights-test:%'").run();
  database.prepare("DELETE FROM audit_events WHERE id LIKE 'fmp-rights-test:%'").run();
  database.prepare("DELETE FROM socratic_decisions WHERE id LIKE 'fmp-rights-test:%'").run();
  database.prepare("DELETE FROM socratic_framework_proposals WHERE id LIKE 'fmp-rights-test:%'").run();
  database.prepare("DELETE FROM trade_proposals WHERE id LIKE 'fmp-rights-test:%'").run();
  database.prepare("DELETE FROM provider_usage_outbox WHERE attempt_id LIKE 'fmp-rights-test:%'").run();
  database.prepare("DELETE FROM provider_dispatch_attempts WHERE id LIKE 'fmp-rights-test:%'").run();
  database.prepare("DELETE FROM settings WHERE key = 'operation_lease:rag-reindex'").run();
});

describe("FMP rights-derived artifact gate", () => {
  it("requires storage/display rights OFF even when ingestion itself is already OFF", async () => {
    const { purgeFmpTranscriptRightsArtifacts } = await import("../src/lib/web-sources/fmp-transcripts");

    await expect(purgeFmpTranscriptRightsArtifacts({ dryRun: false }))
      .rejects.toThrow("Withdraw FMP transcript storage/display rights");
    expect(vectorMocks.purgeVectorNamespaceAll).not.toHaveBeenCalled();
  });

  it("atomically inventories and removes exact chat, prompt-audit, and decision provenance", async () => {
    const {
      captureFmpTranscriptRightsGeneration,
      fmpTranscriptDerivedProvenance,
      inventoryFmpTranscriptRightsArtifacts,
      persistFmpTranscriptDerivedArtifact,
      purgeFmpTranscriptRightsArtifacts,
      recordFmpTranscriptDerivedAudit
    } = await import("../src/lib/web-sources/fmp-transcripts");
    const { getDb } = await import("../src/lib/db");
    const database = getDb();
    const claim = captureFmpTranscriptRightsGeneration()!;
    const provenance = fmpTranscriptDerivedProvenance([{
      source: "fmp-earnings-transcript",
      docType: "earnings-transcript",
      chunkId: "occ:v3:fmp:test"
    }]);
    const chatId = "fmp-rights-test:chat-derived";
    const retainedChatId = "fmp-rights-test:chat-retained";
    const decisionId = "fmp-rights-test:decision";
    const frameworkId = "fmp-rights-test:framework";
    const at = new Date().toISOString();

    persistFmpTranscriptDerivedArtifact({
      claim,
      artifactType: "chat-turn",
      artifactId: chatId,
      userId: "local",
      provenance,
      write: () => database.prepare(`
        INSERT INTO chat_turns (id, user_id, role, text, citations, intent, redacted, model, client_turn_id, created_at)
        VALUES (?, 'local', 'assistant', ?, '[]', NULL, 0, 'test', NULL, ?)
      `).run(chatId, "Derived answer with no verbatim source payload in its provenance ledger.", at)
    });
    database.prepare(`
      INSERT INTO chat_turns (id, user_id, role, text, citations, intent, redacted, model, client_turn_id, created_at)
      VALUES (?, 'local', 'assistant', ?, '[]', NULL, 0, 'test', NULL, ?)
    `).run(retainedChatId, "Literal earnings-transcript text alone is not provenance.", at);

    const promptAuditId = recordFmpTranscriptDerivedAudit({
      claim,
      kind: "prompt_injection_suspected",
      payload: { runId: "fmp-rights-test:run", findings: [{ excerpt: "licensed raw excerpt" }] },
      userId: "local",
      provenance
    });

    persistFmpTranscriptDerivedArtifact({
      claim,
      artifactType: "strategy-decision",
      artifactId: decisionId,
      userId: "local",
      provenance,
      write: () => {
        database.prepare(`
          INSERT INTO socratic_decisions (
            id, user_id, status, authority, thesis, rationale, action,
            evidence, rag_attributions, created_at, updated_at
          ) VALUES (?, 'local', 'observed', 'system', 'test', 'test', 'hold', ?, ?, ?, ?)
        `).run(
          decisionId,
          JSON.stringify([{
            kind: "safety",
            source: "prompt-safety",
            summary: "licensed raw excerpt",
            data: { fmpProvenance: provenance }
          }, { kind: "policy", source: "policy", summary: "retain me" }]),
          JSON.stringify([...provenance, { source: "sec-edgar", docType: "10-q", chunkId: "sec:keep" }]),
          at,
          at
        );
        database.prepare(`
          INSERT INTO socratic_framework_proposals (
            id, user_id, decision_id, status, priority, subsystem, title, rationale,
            proposed_change, evidence, created_at, updated_at
          ) VALUES (?, 'local', ?, 'proposed', 'medium', 'strategy', 'derived', 'derived', 'derived', '[]', ?, ?)
        `).run(frameworkId, decisionId, at, at);
      }
    });

    const before = await inventoryFmpTranscriptRightsArtifacts();
    expect(before).toMatchObject({
      derivedChatTurnIds: [chatId],
      derivedPromptSafetyAuditIds: [promptAuditId],
      derivedDecisionIds: [decisionId],
      derivedFrameworkProposalIds: [frameworkId],
      pendingDerivedProviderWorkIds: [],
      pendingPineconeUpsertAttemptIds: []
    });

    process.env.FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED = "off";
    const purged = await purgeFmpTranscriptRightsArtifacts({ dryRun: false });
    expect(purged.after).toMatchObject({
      derivedAuditIds: [],
      derivedPromptSafetyAuditIds: [],
      derivedChatTurnIds: [],
      derivedDecisionIds: [],
      derivedFrameworkProposalIds: [],
      derivedArtifactIds: [],
      rightsGate: { status: "revoked" }
    });
    expect(database.prepare("SELECT 1 FROM chat_turns WHERE id = ?").get(chatId)).toBeUndefined();
    expect(database.prepare("SELECT 1 FROM chat_turns WHERE id = ?").get(retainedChatId)).toBeDefined();
    expect(database.prepare("SELECT 1 FROM audit_events WHERE id = ?").get(promptAuditId)).toBeUndefined();
    expect(database.prepare("SELECT 1 FROM socratic_framework_proposals WHERE id = ?").get(frameworkId)).toBeUndefined();
    const decision = database.prepare(`
      SELECT evidence, rag_attributions FROM socratic_decisions WHERE id = ?
    `).get(decisionId) as { evidence: string; rag_attributions: string };
    expect(decision.evidence).not.toContain("licensed raw excerpt");
    expect(JSON.parse(decision.evidence)).toEqual([{ kind: "policy", source: "policy", summary: "retain me" }]);
    expect(JSON.parse(decision.rag_attributions)).toEqual([{ source: "sec-edgar", docType: "10-q", chunkId: "sec:keep" }]);

    let staleWriteRan = false;
    expect(() => persistFmpTranscriptDerivedArtifact({
      claim,
      artifactType: "chat-turn",
      artifactId: "fmp-rights-test:stale-chat",
      userId: "local",
      provenance,
      write: () => {
        staleWriteRan = true;
      }
    })).toThrow("rights generation is revoked or stale");
    expect(staleWriteRan).toBe(false);
    expect(captureFmpTranscriptRightsGeneration()).toBeUndefined();
  });

  it("revokes first and blocks until derived provider work has a terminal receipt", async () => {
    const {
      captureFmpTranscriptRightsGeneration,
      completeFmpTranscriptDerivedProviderWork,
      fmpTranscriptDerivedProvenance,
      inventoryFmpTranscriptRightsArtifacts,
      persistFmpTranscriptDerivedArtifact,
      purgeFmpTranscriptRightsArtifacts
    } = await import("../src/lib/web-sources/fmp-transcripts");
    const claim = captureFmpTranscriptRightsGeneration()!;
    const provenance = fmpTranscriptDerivedProvenance([{
      source: "fmp-earnings-transcript",
      docType: "earnings-transcript",
      chunkId: "occ:v3:fmp:provider-work"
    }]);
    const workId = "fmp-rights-test:provider-work";
    persistFmpTranscriptDerivedArtifact({
      claim,
      artifactType: "strategy-decision",
      artifactId: "fmp-rights-test:provider-work-decision",
      userId: "local",
      provenance,
      providerWorkId: workId,
      write: () => undefined
    });

    process.env.FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED = "off";
    await expect(purgeFmpTranscriptRightsArtifacts({ dryRun: false }))
      .rejects.toThrow("unresolved derived provider work");
    expect(vectorMocks.purgeVectorNamespaceAll).not.toHaveBeenCalled();
    const blocked = await inventoryFmpTranscriptRightsArtifacts();
    expect(blocked.rightsGate.status).toBe("revoked");
    expect(blocked.pendingDerivedProviderWorkIds).toEqual([workId]);

    completeFmpTranscriptDerivedProviderWork(workId);
    const purged = await purgeFmpTranscriptRightsArtifacts({ dryRun: false });
    expect(purged.after.pendingDerivedProviderWorkIds).toEqual([]);
    expect(vectorMocks.purgeVectorNamespaceAll).toHaveBeenCalledTimes(1);
  });

  it("does not cross provider deletion while a Pinecone upsert is unresolved", async () => {
    const { inventoryFmpTranscriptRightsArtifacts, purgeFmpTranscriptRightsArtifacts } = await import(
      "../src/lib/web-sources/fmp-transcripts"
    );
    const { getDb } = await import("../src/lib/db");
    const database = getDb();
    const attemptId = "fmp-rights-test:pinecone-upsert";
    const at = new Date().toISOString();
    database.prepare(`
      INSERT INTO provider_dispatch_attempts (
        id, authority_id, provider, operation, credential_ref, user_id, units,
        estimated_cost_usd, status, created_at, dispatched_at, updated_at
      ) VALUES (?, 'test', 'pinecone', 'upsert', 'test', 'local', 1, 0, 'dispatched', ?, ?, ?)
    `).run(attemptId, at, at, at);

    process.env.FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED = "off";
    await expect(purgeFmpTranscriptRightsArtifacts({ dryRun: false }))
      .rejects.toThrow("unresolved Pinecone upsert attempts");
    expect(vectorMocks.purgeVectorNamespaceAll).not.toHaveBeenCalled();
    const blocked = await inventoryFmpTranscriptRightsArtifacts();
    expect(blocked.pendingPineconeUpsertAttemptIds).toEqual([attemptId]);
    expect(blocked.rightsGate.status).toBe("revoked");

    database.prepare(`
      UPDATE provider_dispatch_attempts
      SET status = 'failed', completed_at = ?, updated_at = ? WHERE id = ?
    `).run(at, at, attemptId);
    const purged = await purgeFmpTranscriptRightsArtifacts({ dryRun: false });
    expect(purged.after.pendingPineconeUpsertAttemptIds).toEqual([]);
    expect(vectorMocks.purgeVectorNamespaceAll).toHaveBeenCalledTimes(1);
  });
});
