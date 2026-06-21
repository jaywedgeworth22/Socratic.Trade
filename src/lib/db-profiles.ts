/**
 * db-profiles.ts — Strategy profile CRUD operations.
 * Extracted from db.ts. All DB access goes through getDb() from "./db".
 * Internal helpers (mergePolicy, normalizeScoringWeights, etc.) are imported from "./db".
 */

import crypto from "crypto";
import { getDb, audit, mergePolicy, normalizeScoringWeights, setSettingDirect, syncActiveProfile, getPolicy, getStrategyPrompt } from "./db";
import type { StrategyProfile, TradingPolicy, ScoringWeights } from "./types";

type RawStrategyProfile = {
  id: string;
  name: string;
  policy: string;
  prompt: string;
  scoring_weights: string;
  active: number;
  created_at: string;
  updated_at: string;
};

function toStrategyProfile(row: RawStrategyProfile): StrategyProfile {
  const scoringWeights = normalizeScoringWeights(JSON.parse(row.scoring_weights) as Partial<ScoringWeights>);
  const policy = mergePolicy({ ...(JSON.parse(row.policy) as Partial<TradingPolicy>), scoringWeights, activeProfileId: row.id });
  return {
    id: row.id,
    name: row.name,
    policy,
    prompt: row.prompt,
    scoringWeights,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function listStrategyProfiles(userId: string = "local"): StrategyProfile[] {
  const rows = getDb()
    .prepare("SELECT id, name, policy, prompt, scoring_weights, active, created_at, updated_at FROM strategy_profiles WHERE user_id = ? ORDER BY active DESC, name ASC")
    .all(userId) as RawStrategyProfile[];
  return rows.map(toStrategyProfile);
}

export function getActiveStrategyProfile(userId: string = "local"): StrategyProfile | undefined {
  const row = getDb()
    .prepare("SELECT id, name, policy, prompt, scoring_weights, active, created_at, updated_at FROM strategy_profiles WHERE active = 1 AND user_id = ? LIMIT 1")
    .get(userId) as RawStrategyProfile | undefined;
  return row ? toStrategyProfile(row) : undefined;
}

export function createStrategyProfile(input: { name: string; policy?: Partial<TradingPolicy>; prompt?: string; active?: boolean }, userId: string = "local"): StrategyProfile {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const currentPolicy = getPolicy(userId);
  const policy = mergePolicy({ ...currentPolicy, ...(input.policy ?? {}), activeProfileId: id });
  const prompt = input.prompt ?? getStrategyPrompt(userId);
  const database = getDb();
  const create = database.transaction(() => {
    if (input.active) database.prepare("UPDATE strategy_profiles SET active = 0, updated_at = ? WHERE user_id = ?").run(now, userId);
    database
      .prepare(
        "INSERT INTO strategy_profiles (id, user_id, name, policy, prompt, scoring_weights, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(id, userId, input.name, JSON.stringify(policy), prompt, JSON.stringify(policy.scoringWeights), input.active ? 1 : 0, now, now);
  });
  create();
  if (input.active) {
    setSettingDirect(userId, "policy", policy, now);
    setSettingDirect(userId, "strategyPrompt", prompt, now);
  }
  audit("profile_change", { action: "create", id, name: input.name, active: Boolean(input.active) }, userId);
  return getStrategyProfile(id, userId)!;
}

export function getStrategyProfile(id: string, userId: string = "local"): StrategyProfile | undefined {
  const row = getDb()
    .prepare("SELECT id, name, policy, prompt, scoring_weights, active, created_at, updated_at FROM strategy_profiles WHERE id = ? AND user_id = ?")
    .get(id, userId) as RawStrategyProfile | undefined;
  return row ? toStrategyProfile(row) : undefined;
}

export function updateStrategyProfile(id: string, patch: { name?: string; policy?: Partial<TradingPolicy>; prompt?: string; scoringWeights?: Partial<ScoringWeights> }, userId: string = "local"): StrategyProfile {
  const existing = getStrategyProfile(id, userId);
  if (!existing) throw new Error("Strategy profile not found.");
  const now = new Date().toISOString();
  const scoringWeights = normalizeScoringWeights({ ...existing.scoringWeights, ...(patch.scoringWeights ?? {}) });
  const policy = mergePolicy({ ...existing.policy, ...(patch.policy ?? {}), scoringWeights, activeProfileId: id });
  const prompt = patch.prompt ?? existing.prompt;
  getDb()
    .prepare("UPDATE strategy_profiles SET name = ?, policy = ?, prompt = ?, scoring_weights = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(patch.name ?? existing.name, JSON.stringify(policy), prompt, JSON.stringify(scoringWeights), now, id, userId);
  if (existing.active) {
    setSettingDirect(userId, "policy", policy, now);
    setSettingDirect(userId, "strategyPrompt", prompt, now);
  }
  audit("profile_change", { action: "update", id, name: patch.name ?? existing.name }, userId);
  return getStrategyProfile(id, userId)!;
}

export function activateStrategyProfile(id: string, userId: string = "local"): StrategyProfile {
  const profile = getStrategyProfile(id, userId);
  if (!profile) throw new Error("Strategy profile not found.");
  const now = new Date().toISOString();
  const database = getDb();
  const activate = database.transaction(() => {
    database.prepare("UPDATE strategy_profiles SET active = 0, updated_at = ? WHERE user_id = ?").run(now, userId);
    database.prepare("UPDATE strategy_profiles SET active = 1, updated_at = ? WHERE id = ? AND user_id = ?").run(now, id, userId);
    setSettingDirect(userId, "policy", mergePolicy({ ...profile.policy, activeProfileId: id }), now);
    setSettingDirect(userId, "strategyPrompt", profile.prompt, now);
  });
  activate();
  audit("profile_change", { action: "activate", id, name: profile.name }, userId);
  return getStrategyProfile(id, userId)!;
}
