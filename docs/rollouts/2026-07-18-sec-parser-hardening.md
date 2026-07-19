# 2026-07-18 SEC/RAG Parser & Chunker Hardening

## Summary
Completed the SEC/RAG parser and chunker hardening by resolving outstanding structural and edge-case issues identified in recent parser reviews. Improved deterministic provenance, prevented runaway token allocation, handled XBRL structural anomalies securely, and fixed hidden content / nested table processing.

## Why
A hostile review of the v2 parser integration surfaced several vulnerabilities: forgeable tokenizer/provenance gates, mutable payload-unbound eligibility (date fallback leaks), non-interruptible/pre-allocation bounds (unbounded table iteration), malformed or missing structured XBRL evidence leading to SQLite insertion issues, stylesheet-hidden poisoning, and nested-table extraction loss.

## Files Touched
- `src/lib/rag/chunk.ts`: Added strict deterministic date requirement and explicit validation bounds for `maxTokens`.
- `src/lib/web-sources/sec-parser.ts`: Clamped table colspan/rowspan iteration to bounded maximums. Stripped stylesheet-hidden nodes using strict opacity/font-size constraints. Altered nested table node extraction to replace with markdown representations inline, preserving reading order and structures.
- `src/lib/web-sources/sec-facts.ts`: Shielded against SQLite insertion of NaN/nulls and enforced strict structure checking for XBRL attributes `filed`, `shares`, and `price`.
- `test/rag-chunk.test.ts`: Brought test fixtures up to date to conform to strict deterministic `published_at` rules.

## Verification
- Run `npm run lint` - Success
- Run `npx tsc --noEmit` - Success
- Run `npm test -- test/rag-chunk.test.ts` - Success
- Run `npm run build` - Success
