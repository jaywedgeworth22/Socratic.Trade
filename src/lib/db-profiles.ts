// db-profiles.ts — strategy profiles (create/read/update/delete/activate),
// plus mergePolicy / normalizeScoringWeights helpers used only by this module
// and the re-exported getPolicy / setPolicy / getStrategyPrompt / setStrategyPrompt.
import crypto from "crypto";
import { getDb, audit } from "./db";
import { getUserSetting, setUserSetting } from "./db-settings";
import { getActiveConnectedAccount, getConnectedAccount, listConnectedAccounts } from "./db-api-keys";
import { DEFAULT_POLICY, DEFAULT_SCORING_WEIGHTS, DEFAULT_STRATEGY_PROMPT } from "./defaults";
import type {
  ScoringWeights,
  StrategyProfile,
  TradingPolicy
} from "./types";

// ── User-level vs account-level policy field split ─────────────────────────────
// User-level fields are stored in user_settings.policy and overlaid on top of the
// account-level base on every read. Account-level fields live in account_strategy_state.
// New additions must be added to the set below to ensure they land in the correct store.

const USER_LEVEL_POLICY_FIELDS = new Set<keyof TradingPolicy>([
  "llmModel",
  "redTeamLlmModel",
  "llmReasoningEffort",
  "notificationSettings",
  "marketScanCandidateLimit",
  "marketScanOutlierReserve"
]);

/** Extract only the user-level fields from a TradingPolicy. */
function pickUserFields(policy: TradingPolicy): Partial<TradingPolicy> {
  const result: Partial<TradingPolicy> = {};
  for (const key of USER_LEVEL_POLICY_FIELDS) {
    if (key in policy) {
      (result as Record<string, unknown>)[key as string] = policy[key];
    }
  }
  return result;
}

/** Extract only the account-level fields from a TradingPolicy (everything NOT in USER_LEVEL_POLICY_FIELDS). */
function pickAccountFields(policy: TradingPolicy): Partial<TradingPolicy> {
  const result: Partial<TradingPolicy> = {};
  for (const key of Object.keys(policy) as Array<keyof TradingPolicy>) {
    if (!USER_LEVEL_POLICY_FIELDS.has(key) && key !== "scoringWeights") {
      (result as Record<string, unknown>)[key as string] = policy[key];
    }
  }
  // scoringWeights are already handled inside mergePolicy, write them to the account policy
  if (policy.scoringWeights) {
    result.scoringWeights = policy.scoringWeights;
  }
  return result;
}

/** Drop user-level fields from legacy account rows before applying the user-level overlay. */
function stripUserFields(policy: Partial<TradingPolicy>): Partial<TradingPolicy> {
  const result: Partial<TradingPolicy> = { ...policy };
  for (const key of USER_LEVEL_POLICY_FIELDS) {
    delete result[key];
  }
  return result;
}

/** Read user-level policy fields from user_settings and return them as a partial policy. */
function readUserPolicyFields(userId: string): Partial<TradingPolicy> {
  const stored = getUserSetting<Partial<TradingPolicy>>(userId, "policy", {});
  if (!stored || typeof stored !== "object") return {};
  // Only pluck the known user-level fields from whatever is stored (backward-compat:
  // existing DBs have the full policy in user_settings — we only care about user fields now).
  const result: Partial<TradingPolicy> = {};
  for (const key of USER_LEVEL_POLICY_FIELDS) {
    if (key in stored) {
      (result as Record<string, unknown>)[key as string] = stored[key];
    }
  }
  return result;
}

/** Write only the user-level fields of a policy to user_settings.policy. */
function writeUserPolicyFields(userId: string, policy: TradingPolicy): void {
  const userFields = pickUserFields(policy);
  setUserSetting(userId, "policy", userFields);
}

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

// ── Per-account live strategy state (account_strategy_state) ──────────────────
// strategy_profiles is the user-level copyable LIBRARY; account_strategy_state is
// what a given connected account is actually running. Reads go through getPolicy
// (which prefers the account's live row); every effective-policy writer mirrors into
// it via mirrorPolicyToActiveAccount, so the live row never goes stale. Lazily seeded
// on first read so existing single-account users are byte-identical day one.

type RawAccountStrategyState = {
  policy: string;
  prompt: string | null;
  scoring_weights: string | null;
  system_state: string;
  derived_from_profile_id: string | null;
};

/** Resolve the account whose live state applies: an explicit id, else the active account. */
function resolveAccount(userId: string, connectedAccountId?: string) {
  if (connectedAccountId) return listConnectedAccounts(userId).find((a) => a.id === connectedAccountId);
  return getActiveConnectedAccount(userId);
}

function getAccountStrategyStateRow(userId: string, connectedAccountId: string): RawAccountStrategyState | undefined {
  return getDb()
    .prepare(
      "SELECT policy, prompt, scoring_weights, system_state, derived_from_profile_id FROM account_strategy_state WHERE user_id = ? AND connected_account_id = ?"
    )
    .get(userId, connectedAccountId) as RawAccountStrategyState | undefined;
}

function writeAccountStrategyState(
  userId: string,
  connectedAccountId: string,
  args: { policy: TradingPolicy; prompt: string; scoringWeights: ScoringWeights; derivedFromProfileId?: string | null }
): void {
  getDb()
    .prepare(
      `INSERT INTO account_strategy_state
         (user_id, connected_account_id, policy, prompt, scoring_weights, system_state, derived_from_profile_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, connected_account_id) DO UPDATE SET
         policy = excluded.policy, prompt = excluded.prompt, scoring_weights = excluded.scoring_weights,
         system_state = excluded.system_state,
         derived_from_profile_id = COALESCE(excluded.derived_from_profile_id, account_strategy_state.derived_from_profile_id),
         updated_at = excluded.updated_at`
    )
    .run(
      userId,
      connectedAccountId,
      JSON.stringify(args.policy),
      args.prompt,
      JSON.stringify(args.scoringWeights),
      args.policy.systemState,
      args.derivedFromProfileId ?? null,
      new Date().toISOString()
    );
}

/**
 * Mirror the user's new effective policy/prompt into the ACTIVE account's live state.
 * Called by every effective-policy writer so account_strategy_state never goes stale.
 * No-op when there is no active connected account (legacy single-context behavior).
 */
function mirrorPolicyToActiveAccount(
  userId: string,
  policy: TradingPolicy,
  prompt: string,
  scoringWeights: ScoringWeights,
  derivedFromProfileId?: string | null
): void {
  const account = getActiveConnectedAccount(userId);
  if (!account) return;
  writeAccountStrategyState(userId, account.id, { policy, prompt, scoringWeights, derivedFromProfileId });
}

/** The user-level base policy (active library profile, else legacy user_settings). */
function getBasePolicy(userId: string): TradingPolicy {
  const active = getActiveStrategyProfile(userId);
  if (active) return mergePolicy({ ...active.policy, activeProfileId: active.id });
  return mergePolicy(getUserSetting(userId, "policy", DEFAULT_POLICY));
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

export function getPolicy(userId: string = "local", connectedAccountId?: string): TradingPolicy {
  const account = resolveAccount(userId, connectedAccountId);
  let policy: TradingPolicy;

  if (account) {
    const state = getAccountStrategyStateRow(userId, account.id);
    if (state) {
      const stored = JSON.parse(state.policy) as Partial<TradingPolicy>;
      const scoringWeights = normalizeScoringWeights(
        (state.scoring_weights ? JSON.parse(state.scoring_weights) : stored.scoringWeights ?? {}) as Partial<ScoringWeights>
      );
      policy = mergePolicy({ ...stripUserFields(stored), scoringWeights });
    } else {
      policy = getBasePolicy(userId);
      const activeId = getActiveConnectedAccount(userId)?.id;
      if (account.id !== activeId && policy.systemState === "active") {
        policy = { ...policy, systemState: "halted" };
      }
      writeAccountStrategyState(userId, account.id, {
        policy,
        prompt: getStrategyPrompt(userId, account.id),
        scoringWeights: policy.scoringWeights,
        derivedFromProfileId: policy.activeProfileId ?? null
      });
    }
    // Overlay user-level fields from user_settings.policy on top of the account base.
    // This makes user-level settings (LLM models, notifications, scan limits) apply
    // consistently across all accounts while keeping risk/strategy per-account.
    const userFields = readUserPolicyFields(userId);
    policy = mergePolicy({ ...policy, ...userFields });
    policy.connectedAccountId = account.id;
    policy.activeBroker = account.broker;
    policy.accountNumber = account.accountNumber;
    policy.paperMode = account.broker === "test";
  } else {
    policy = getBasePolicy(userId);
    policy.paperMode = true;
  }

  return policy;
}

/**
 * Read-only policy projection for diagnostics. Never seeds `account_strategy_state`.
 * When no per-account row exists, returns the same effective policy `getPolicy` would
 * compute on first touch — without persisting it.
 */
export function peekPolicy(userId: string = "local", connectedAccountId?: string): TradingPolicy {
  const account = resolveAccount(userId, connectedAccountId);
  let policy: TradingPolicy;

  if (account) {
    const state = getAccountStrategyStateRow(userId, account.id);
    if (state) {
      const stored = JSON.parse(state.policy) as Partial<TradingPolicy>;
      const scoringWeights = normalizeScoringWeights(
        (state.scoring_weights ? JSON.parse(state.scoring_weights) : stored.scoringWeights ?? {}) as Partial<ScoringWeights>
      );
      policy = mergePolicy({ ...stripUserFields(stored), scoringWeights });
    } else {
      policy = getBasePolicy(userId);
      const activeId = getActiveConnectedAccount(userId)?.id;
      if (account.id !== activeId && policy.systemState === "active") {
        policy = { ...policy, systemState: "halted" };
      }
    }
    policy.connectedAccountId = account.id;
    policy.activeBroker = account.broker;
    policy.accountNumber = account.accountNumber;
    policy.paperMode = account.broker === "test";
  } else {
    policy = getBasePolicy(userId);
    policy.paperMode = true;
  }

  return policy;
}

export function setPolicy(policy: TradingPolicy, userId: string = "local", connectedAccountId?: string): void {
  const merged = mergePolicy(policy);
  const account = resolveAccount(userId, connectedAccountId);

  if (account) {
    // ── Tiered write: user fields → user_settings, account fields → account_strategy_state ──
    writeUserPolicyFields(userId, merged);
    syncActiveProfile({ policy: pickAccountFields(merged) as TradingPolicy, scoringWeights: merged.scoringWeights }, userId);
    writeAccountStrategyState(userId, account.id, {
      policy: pickAccountFields(merged) as TradingPolicy,
      prompt: getStrategyPrompt(userId, account.id),
      scoringWeights: merged.scoringWeights
    });
  } else {
    // ── No connected account: store the full policy in user_settings (backward compat) ──
    // Users without a connected account (legacy single-user mode) keep the old behaviour:
    // the full policy is stored as a single blob under user_settings.policy.
    setUserSetting(userId, "policy", merged);
    syncActiveProfile({ policy: merged, scoringWeights: merged.scoringWeights }, userId);
  }
}

export function getStrategyPrompt(userId: string = "local", connectedAccountId?: string): string {
  const account = resolveAccount(userId, connectedAccountId);
  if (account) {
    const state = getAccountStrategyStateRow(userId, account.id);
    if (state?.prompt != null) return state.prompt;
  }
  return getActiveStrategyProfile(userId)?.prompt ?? getUserSetting(userId, "strategyPrompt", DEFAULT_STRATEGY_PROMPT);
}

export function setStrategyPrompt(prompt: string, userId: string = "local", connectedAccountId?: string): void {
  setUserSetting(userId, "strategyPrompt", prompt);
  syncActiveProfile({ prompt }, userId);
  const account = resolveAccount(userId, connectedAccountId);
  if (account) {
    const base = getPolicy(userId, account.id);
    writeAccountStrategyState(userId, account.id, { policy: base, prompt, scoringWeights: base.scoringWeights });
  }
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
    mirrorPolicyToActiveAccount(userId, policy, prompt, policy.scoringWeights, id);
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
    mirrorPolicyToActiveAccount(userId, policy, prompt, scoringWeights, id);
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
  // Activating a library strategy copies it into the active account's live state.
  mirrorPolicyToActiveAccount(userId, mergePolicy({ ...profile.policy, activeProfileId: id }), profile.prompt, profile.policy.scoringWeights, id);
  audit("profile_change", { action: "activate", id, name: profile.name }, userId);
  return getStrategyProfile(id, userId)!;
}

/**
 * PR 2 — copy a saved library strategy into a CHOSEN account's live state (not just the active one,
 * which is what `activateStrategyProfile` does). The library profile and which account is active are
 * left untouched: this only writes the target account's `account_strategy_state` row, stamping
 * `derived_from_profile_id` so the provenance is recorded. Copy, not link — later edits to the
 * library profile do not retro-mutate the account.
 *
 * SAFETY: the target account's current run-state (`systemState`) is preserved. Applying a strategy
 * is a config change; it must never arm autonomy on a halted account (nor disarm an active one),
 * mirroring the per-account autonomy-opt-in guard from PR 1.
 */
export function applyProfileToAccount(
  profileId: string,
  connectedAccountId: string,
  userId: string = "local"
): { profileId: string; connectedAccountId: string } {
  const profile = getStrategyProfile(profileId, userId);
  if (!profile) throw new Error("Strategy profile not found.");
  const account = getConnectedAccount(connectedAccountId, userId);
  if (!account) throw new Error("Connected account not found.");

  const currentState = getPolicy(userId, connectedAccountId).systemState;
  const scoringWeights = normalizeScoringWeights(profile.policy.scoringWeights);
  const policy = mergePolicy({
    ...profile.policy,
    scoringWeights,
    systemState: currentState,
    activeProfileId: profile.id
  });
  writeAccountStrategyState(userId, connectedAccountId, {
    policy,
    prompt: profile.prompt,
    scoringWeights,
    derivedFromProfileId: profile.id
  });
  audit(
    "profile_change",
    { action: "copy_to_account", id: profileId, name: profile.name, connectedAccountId },
    userId,
    connectedAccountId
  );
  return { profileId, connectedAccountId };
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
