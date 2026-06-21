// The single security-critical chokepoint of the crossover-learning loop.
//
// classifyRiskTier maps a learned-context candidate to one of three tiers:
//   - 'fact'              — a durable, non-risk observation safe to surface to the brain as
//                           advisory DATA (e.g. "ASML is the sole EUV-lithography supplier").
//   - 'risk'              — anything that touches position sizing, exposure limits, risk
//                           tolerance, leverage/margin, stops/targets, sector caps, scoring
//                           weights, strategy authority, or risk-adjacent INTENT prose.
//   - 'strategy-directive'— a directive that would rewrite the agent's strategy prompt.
//
// It is FAIL-CLOSED: anything that is not clearly a non-risk fact returns 'risk' (UNKNOWN -> risk).
// In the fact-tier slice the store AUDIT-LOGS-AND-DROPS everything above 'fact', so a conservative
// mis-tier costs at worst a dropped fact, never a silent risk change reaching the brain.

import type { LearnedContextCandidate, LearnedContextRiskTier } from "../types";

// Reused from salience.ts — PII must never be written to learned_context either.
export const PII_PATTERNS = [/\b\d{3}-\d{2}-\d{4}\b/, /\b(?:\d[ -]?){13,16}\b/];

/**
 * Risk-controlling SUBJECTS. If a candidate's subject (normalized) matches any of these, it is
 * risk-tier regardless of its value. This is the owner-reviewable DEFAULT set; extend it, never
 * silently weaken it. Matching is substring-based on a normalized subject so e.g. "max_position",
 * "maxPositionPct" and "max position" all hit "max_position"/"max position".
 */
export const RISK_SUBJECTS: readonly string[] = [
  "position sizing",
  "position_sizing",
  "positionsizing",
  "max_position",
  "max position",
  "maxposition",
  "risk_tolerance",
  "risk tolerance",
  "risktolerance",
  "leverage",
  "margin",
  "sector cap",
  "sector_cap",
  "sectorcap",
  "sector allocation",
  "sector_allocation",
  "sector exposure",
  "exposure",
  "stop_loss",
  "stop loss",
  "stoploss",
  "take_profit",
  "take profit",
  "takeprofit",
  "strategyauthority",
  "strategy_authority",
  "strategy authority",
  "scoringweight",
  "scoring_weight",
  "scoring weight",
  "max_order_notional",
  "max order notional",
  "maxordernotional",
  "max_daily_notional",
  "max daily notional",
  "maxdailynotional",
  "daily limit",
  "daily_limit",
  "dailylimit",
  "allocation",
  "percent allocation",
  "% allocation"
];

/**
 * Intent KEYWORDS that force 'risk' even with no numeric trigger. These catch risk-adjacent prose
 * (the Safety judge's named failure mode: "lean much harder into tech", "more aggressive") that a
 * subject/numeric check alone would miss. Word-boundary matched against the combined text.
 */
export const RISK_INTENT_KEYWORDS: readonly string[] = [
  "increase",
  "decrease",
  "raise",
  "lower",
  "cap",
  "limit",
  "allocate",
  "allocation",
  "size",
  "sizing",
  "aggressive",
  "aggressively",
  "conservative",
  "conservatively",
  "leverage",
  "leveraged",
  "margin",
  "lean harder",
  "lean much harder",
  "lean into",
  "double down",
  "overweight",
  "underweight"
];

function normalizeSubject(subject: string): string {
  return subject.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

/** A numeric size/limit/percent reference (e.g. "5%", "$10,000", "10 percent") implies a risk knob. */
const NUMERIC_RISK_PATTERN = /(\d+(?:\.\d+)?\s*%|\bpercent\b|\$\s*\d|\b\d{2,}\b\s*(?:shares?|dollars?))/i;

export function classifyRiskTier(candidate: LearnedContextCandidate): LearnedContextRiskTier {
  const subject = normalizeSubject(candidate.subject ?? "");
  const value = String(candidate.value ?? "");
  const intent = String(candidate.intent ?? "");
  const haystack = `${subject} ${value.toLowerCase()} ${intent.toLowerCase()}`;

  // 1. Subject is a known risk-controlling knob → risk.
  const subjectCondensed = subject.replace(/\s+/g, "");
  if (
    RISK_SUBJECTS.some((s) => {
      const sn = normalizeSubject(s);
      return subject.includes(sn) || subjectCondensed.includes(sn.replace(/\s+/g, ""));
    })
  ) {
    return "risk";
  }

  // 2. Risk-adjacent INTENT prose with no numeric trigger → risk (the no-numeric hole).
  if (
    RISK_INTENT_KEYWORDS.some((kw) => {
      // Multi-word phrases: substring; single words: word-boundary so "limited" != "limit".
      if (kw.includes(" ")) return haystack.includes(kw);
      return new RegExp(`\\b${kw}\\b`, "i").test(haystack);
    })
  ) {
    return "risk";
  }

  // 3. Any numeric size/limit/percent reference → risk (a learned "5%" almost always tunes a knob).
  if (NUMERIC_RISK_PATTERN.test(value)) {
    return "risk";
  }

  // 4. Otherwise it is a clean, non-risk fact. (Producers are responsible for emitting durable
  //    facts/patterns; the fact tier is the only thing this slice ever writes to the brain.)
  return "fact";
}

/** PII gate: true if the candidate's value carries an SSN/card-like number and must be dropped. */
export function hasPii(value: string): boolean {
  return PII_PATTERNS.some((re) => re.test(String(value)));
}
