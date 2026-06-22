// db-profiles.ts — strategy profiles (create/read/update/delete/activate),
// plus mergePolicy / normalizeScoringWeights helpers used only by this module
// and the re-exported getPolicy / setPolicy / getStrategyPrompt / setStrategyPrompt.
import crypto from "crypto";
import { getDb, audit } from "./db";
import { getUserSetting, setUserSetting } from "./db-settings";
import { getActiveConnectedAccount } from "./db-api-keys";
import { DEFAULT_POLICY, DEFAULT_SCORING_WEIGHTS, DEFAULT_STRATEGY_PROMPT } from "./defaults";
import type {
  ScoringWeights,
  StrategyProfile,
  TradingPolicy
} from "./types";

// ── Internal raw-row type ──────────────────────────────────────────────────────

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

// ── Policy/weight helpers (private to this module) ────────────────────────────

export function mergePolicy(policy: Partial<TradingPolicy>): TradingPolicy {
  // Back-compat shim: older stored policies used `dryRun` instead of `paperMode`.
  const legacy = policy as Partial<TradingPolicy> & { dryRun?: boolean };
  const paperMode = policy.paperMode ?? legacy.dryRun ?? DEFAULT_POLICY.paperMode;
  const { dryRun: _legacyDryRun, ...policyWithoutLegacyDryRun } = legacy;
  const merged: TradingPolicy = {
    ...DEFAULT_POLICY,
    ...policyWithoutLegacyDryRun,
    paperMode,
    scoringWeights: normalizeScoringWeights(policy.scoringWeights ?? DEFAULT_POLICY.scoringWeights),
    sectorCaps: policy.sectorCaps ?? DEFAULT_POLICY.sectorCaps,
    riskRules: { ...DEFAULT_POLICY.riskRules, ...(policy.riskRules ?? {}) },
    notificationSettings: {
      ...DEFAULT_POLICY.notificationSettings,
      ...(policy.notificationSettings ?? {}),
      enabledEvents:
        policy.notificationSettings?.enabledEvents ?? DEFAULT_POLICY.notificationSettings.enabledEvents
    }
  };
  if ((merged.maxDailyNotional ?? 0) >= 500_000) {
    merged.maxDailyNotional = DEFAULT_POLICY.maxDailyNotional;
    if (merged.maxDailyOrders > DEFAULT_POLICY.maxDailyOrders) merged.maxDailyOrders = DEFAULT_POLICY.maxDailyOrders;
  }
  if ((merged.maxOrderNotional ?? 0) > 100_000) merged.maxOrderNotional = 100_000;
  return merged;
}

export function normalizeScoringWeights(weights: Partial<ScoringWeights>): ScoringWeights {
  return {
    ...DEFAULT_SCORING_WEIGHTS,
    ...Object.fromEntries(
      Object.entries(weights).map(([key, value]) => [key, Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0])
    )
  };
}

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

function setSettingDirect(userId: string, key: string, value: unknown, updatedAt: string): void {
  getDb()
    .prepare(
      "INSERT INTO user_settings (id, user_id, key, value, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    )
    .run(`${userId}_${key}`, userId, key, JSON.stringify(value), updatedAt);
}

function syncActiveProfile(patch: { policy?: TradingPolicy; prompt?: string; scoringWeights?: ScoringWeights }, userId: string = "local"): void {
  const active = getActiveStrategyProfile(userId);
  if (!active) return;
  const policy = patch.policy ? mergePolicy({ ...patch.policy, activeProfileId: active.id }) : active.policy;
  const prompt = patch.prompt ?? active.prompt;
  const scoringWeights = patch.scoringWeights ?? policy.scoringWeights;
  getDb()
    .prepare("UPDATE strategy_profiles SET policy = ?, prompt = ?, scoring_weights = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(JSON.stringify(policy), prompt, JSON.stringify(scoringWeights), new Date().toISOString(), active.id, userId);
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function getPolicy(userId: string = "local"): TradingPolicy {
  let policy: TradingPolicy;
  const active = getActiveStrategyProfile(userId);
  if (active) policy = mergePolicy({ ...active.policy, activeProfileId: active.id });
  else policy = mergePolicy(getUserSetting(userId, "policy", DEFAULT_POLICY));

  const activeAccount = getActiveConnectedAccount(userId);
  if (activeAccount) {
    policy.connectedAccountId = activeAccount.id;
    policy.activeBroker = activeAccount.broker;
    policy.accountNumber = activeAccount.accountNumber;
    // The active account IS the mode: the Test account runs the local simulator
    // (paperMode), while any real broker account (Alpaca paper/brokerage, Robinhood)
    // runs against the broker. There is no separate paperMode override anymore.
    policy.paperMode = activeAccount.broker === "test";
  } else {
    policy.paperMode = true;
  }

  return policy;
}

export function setPolicy(policy: TradingPolicy, userId: string = "local"): void {
  const merged = mergePolicy(policy);
  setUserSetting(userId, "policy", merged);
  syncActiveProfile({ policy: merged, scoringWeights: merged.scoringWeights }, userId);
}

export function getStrategyPrompt(userId: string = "local"): string {
  return getActiveStrategyProfile(userId)?.prompt ?? getUserSetting(userId, "strategyPrompt", DEFAULT_STRATEGY_PROMPT);
}

export function setStrategyPrompt(prompt: string, userId: string = "local"): void {
  setUserSetting(userId, "strategyPrompt", prompt);
  syncActiveProfile({ prompt }, userId);
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

/**
 * Delete a strategy profile owned by `userId`.
 *
 * Decision (M3, 2026-06-21): if the deleted profile was the active one, the active flag is
 * reassigned to the OLDEST remaining profile (by created_at). If there are no remaining profiles
 * the user is left with none active — callers should create a new profile in that case.
 * The function throws if the profile does not exist or does not belong to `userId`.
 */
export function deleteStrategyProfile(id: string, userId: string = "local"): void {
  const existing = getStrategyProfile(id, userId);
  if (!existing) throw new Error("Strategy profile not found.");
  const database = getDb();
  const now = new Date().toISOString();
  const wasActive = existing.active;
  const del = database.transaction(() => {
    database.prepare("DELETE FROM strategy_profiles WHERE id = ? AND user_id = ?").run(id, userId);
    if (wasActive) {
      // Reassign the active flag to the oldest remaining profile for this user.
      database
        .prepare(
          "UPDATE strategy_profiles SET active = 1, updated_at = ? WHERE id = (SELECT id FROM strategy_profiles WHERE user_id = ? ORDER BY created_at ASC LIMIT 1)"
        )
        .run(now, userId);
    }
  });
  del();
  audit("profile_change", { action: "delete", id, name: existing.name, wasActive }, userId);
}
