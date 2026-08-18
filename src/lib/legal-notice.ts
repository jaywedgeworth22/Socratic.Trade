/**
 * Versioned legal clickwrap + desk notice.  Same pattern as Coach's PROMPT_VERSION
 * bundle and DATA_POOL_CONSENT_VERSION: accept once at the current version, then
 * the gate stays dismissed until the copy/terms materially change.
 *
 * Owner cut 2026-08-17 items 9–11: dismissible (does not reappear after accept),
 * mandatory market-data share, Privacy names self-serve deletion / backup TTL /
 * shared RAG corpus.  Not a paywall.  Multi-user isolation still applies.
 */

export const LEGAL_NOTICE_VERSION = 1;

/** One-line desk sentence — also the strategy-prompt framing. */
export const LEGAL_NOTICE_SENTENCE = "Not investment advice.  You set authority.";

/** Green/Red system-prompt sentence.  Bump STRATEGY_PROMPT_VERSION when this changes. */
export const STRATEGY_LEGAL_SENTENCE =
  "This software is a user-configured trading tool, not investment advice.  The owner sets authority; propose only within those settings.";

/** Production Litestream snapshot retention (`litestream.coolify.yml` snapshot.retention). */
export const BACKUP_RETENTION_HOURS = 168;
export const BACKUP_RETENTION_DAYS = 7;

export const LEGAL_TERMS_PATH = "/terms-and-conditions";
export const LEGAL_PRIVACY_PATH = "/privacy-policy";
