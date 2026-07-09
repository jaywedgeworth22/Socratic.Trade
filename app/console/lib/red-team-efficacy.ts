import type { RedTeamEfficacy, RedTeamVetoRecord } from "@/lib/performance";

export const RED_TEAM_EFFICACY_MIN_RESOLVED = 20;
export const RED_TEAM_EFFICACY_SOLID_RESOLVED = 50;
export const RED_TEAM_UNATTRIBUTED_MODEL = "unattributed";

export type RedTeamSampleTier = "hidden" | "caution" | "ready";
export type RedTeamReturnTone = "pos" | "neg" | "muted";

export interface RedTeamModelRow {
  model: string;
  maturedVetoes: number;
  vetoValueAddRate: number;
  survivorRiskHitRate: number;
  avgReturnPct: number;
}

function summarizeRecords(model: string, records: RedTeamVetoRecord[]): RedTeamModelRow {
  const avoidedLosers = records.filter((record) => record.returnPct < 0).length;
  const missedWinners = records.filter((record) => record.returnPct > 0).length;
  const avgReturnPct = records.reduce((sum, record) => sum + record.returnPct, 0) / records.length;
  return {
    model,
    maturedVetoes: records.length,
    vetoValueAddRate: Number(((avoidedLosers / records.length) * 100).toFixed(1)),
    survivorRiskHitRate: Number(((missedWinners / records.length) * 100).toFixed(1)),
    avgReturnPct: Number(avgReturnPct.toFixed(2))
  };
}

export function redTeamSampleTier(resolvedVetoes: number): RedTeamSampleTier {
  if (resolvedVetoes < RED_TEAM_EFFICACY_MIN_RESOLVED) return "hidden";
  if (resolvedVetoes < RED_TEAM_EFFICACY_SOLID_RESOLVED) return "caution";
  return "ready";
}

export function redTeamSampleGate(resolvedVetoes: number): string {
  const tier = redTeamSampleTier(resolvedVetoes);
  if (tier === "ready") return `resolved n=${resolvedVetoes}`;
  if (tier === "caution") return `small sample (n=${resolvedVetoes})`;
  return `needs >=${RED_TEAM_EFFICACY_MIN_RESOLVED} resolved vetoes (n=${resolvedVetoes})`;
}

export function redTeamAttributionLabel(model: string | null | undefined): string {
  return model?.trim() ? model : RED_TEAM_UNATTRIBUTED_MODEL;
}

export function redTeamReturnTone(returnPct: number): RedTeamReturnTone {
  if (returnPct < 0) return "pos";
  if (returnPct > 0) return "neg";
  return "muted";
}

export function buildRedTeamModelRows(efficacy: RedTeamEfficacy | null | undefined): RedTeamModelRow[] {
  if (!efficacy) return [];
  const rows: RedTeamModelRow[] = [...efficacy.byModel];
  const unattributed = efficacy.records.filter((record) => !record.model);
  if (unattributed.length > 0) rows.push(summarizeRecords(RED_TEAM_UNATTRIBUTED_MODEL, unattributed));
  return rows.sort((a, b) => b.maturedVetoes - a.maturedVetoes || a.model.localeCompare(b.model));
}
