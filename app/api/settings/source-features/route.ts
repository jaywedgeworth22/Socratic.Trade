import { NextRequest, NextResponse } from "next/server";
import { resolveRequestUserId } from "@/lib/request-user";
import {
  SOURCE_SETTING_GROUPS,
  SOURCE_SETTINGS_CATALOG,
  type SourceSettingGroup
} from "@/lib/source-settings-catalog";
import {
  getUserSourceSettingsMap,
  listEffectiveSourceSettings,
  patchUserSourceSettings
} from "@/lib/source-settings";
import { getPolicy, setPolicy } from "@/lib/db";
import type { TradingPolicy } from "@/lib/types";

export const dynamic = "force-dynamic";

const FMP_POLICY_KEYS = [
  "fmpRealTimeDataEnabled",
  "fmpMacroDataEnabled",
  "fmpEventsDataEnabled",
  "fmpFundamentalsDataEnabled"
] as const;

/**
 * GET — catalog + effective values (user override / env / default) for Settings UI.
 * PATCH — { settings: { [id]: value | null } } null resets to env+default.
 * FMP product module keys also write TradingPolicy so existing policy readers stay in sync.
 */
export async function GET(request: NextRequest) {
  const userId = resolveRequestUserId(request, {});
  const policy = getPolicy(userId);
  const rows = listEffectiveSourceSettings(userId).map((row) => {
    // Overlay policy for FMP module flags so UI matches getPolicy.
    let value = row.value;
    let source = row.source;
    if (row.spec.id === "fmpRealTimeDataEnabled" && typeof policy.fmpRealTimeDataEnabled === "boolean") {
      value = policy.fmpRealTimeDataEnabled;
      source = "user";
    }
    if (row.spec.id === "fmpMacroDataEnabled" && typeof policy.fmpMacroDataEnabled === "boolean") {
      value = policy.fmpMacroDataEnabled;
      source = "user";
    }
    if (row.spec.id === "fmpEventsDataEnabled" && typeof policy.fmpEventsDataEnabled === "boolean") {
      value = policy.fmpEventsDataEnabled;
      source = "user";
    }
    if (row.spec.id === "fmpFundamentalsDataEnabled" && typeof policy.fmpFundamentalsDataEnabled === "boolean") {
      value = policy.fmpFundamentalsDataEnabled;
      source = "user";
    }
    return {
      id: row.spec.id,
      group: row.spec.group,
      label: row.spec.label,
      description: row.spec.description,
      type: row.spec.type,
      defaultValue: row.spec.defaultValue,
      min: row.spec.min,
      max: row.spec.max,
      advanced: row.spec.advanced ?? false,
      caveat: row.spec.caveat,
      value,
      source
    };
  });

  return NextResponse.json({
    ok: true,
    groups: SOURCE_SETTING_GROUPS,
    settings: rows,
    overrides: getUserSourceSettingsMap(userId)
  });
}

export async function PATCH(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      settings?: Record<string, boolean | number | string | null | undefined>;
    };
    const userId = resolveRequestUserId(request, body as { userId?: string });
    if (!body.settings || typeof body.settings !== "object") {
      return NextResponse.json({ error: "settings object required" }, { status: 400 });
    }

    // Split FMP policy keys vs source_settings map
    const policyPatch: Partial<TradingPolicy> = {};
    const sourcePatch: Record<string, boolean | number | string | null | undefined> = {};
    for (const [k, v] of Object.entries(body.settings)) {
      if ((FMP_POLICY_KEYS as readonly string[]).includes(k)) {
        if (typeof v === "boolean") {
          (policyPatch as Record<string, boolean>)[k] = v;
        } else if (v === null || v === undefined) {
          (policyPatch as Record<string, boolean>)[k] = false;
        }
        // Also store in source map for listEffectiveSourceSettings
        sourcePatch[k] = typeof v === "boolean" ? v : null;
      } else {
        const known = SOURCE_SETTINGS_CATALOG.some((s) => s.id === k);
        if (!known) {
          return NextResponse.json({ error: `Unknown setting: ${k}` }, { status: 400 });
        }
        sourcePatch[k] = v;
      }
    }

    if (Object.keys(policyPatch).length > 0) {
      const current = getPolicy(userId);
      setPolicy({ ...current, ...policyPatch }, userId);
    }
    const overrides = patchUserSourceSettings(userId, sourcePatch);

    return NextResponse.json({ ok: true, overrides });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export type { SourceSettingGroup };
