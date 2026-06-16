# Handoff Standard

This repo is meant to be easy to resume from any LLM platform without requiring
the next tool to reconstruct context from chat history. The documentation model
is intentionally split by purpose so each file stays short, trustworthy, and
retrieval-friendly.

## File Roles

### `AGENTS.md`

Use for durable repo rules only:

- startup ritual
- verification requirements
- cross-file invariants
- dangerous assumptions and traps
- safety boundaries

Do not use it for temporary status, work logs, or feature plans that will drift.

### `STATUS.md`

Use for the current project snapshot:

- what the app is
- current active focus
- known risks
- what to read first
- when this snapshot should be updated

This file should answer, "What is true right now?" in under a minute.

### `PLAN.md`

Use for the stable roadmap:

- phases
- sequencing
- acceptance checks

This is the long-lived "where the project is headed" file, not a changelog.

### `docs/*.md`

Use for feature or phase design:

- problem statement
- chosen design
- invariants
- tradeoffs
- sequencing
- open questions

If a design changes materially, update the relevant doc and record that change
in a rollout note.

### `docs/rollouts/*.md`

Use for dated implementation and decision notes:

- what changed
- why it changed
- exact files touched
- exact verification run
- known follow-ups or blockers

This is the primary cross-platform handoff trail.

## Reading Order For A Cold Start

1. `AGENTS.md`
2. `STATUS.md`
3. `PLAN.md`
4. relevant `docs/*.md`
5. latest relevant `docs/rollouts/*.md`
6. `git log -3`
7. current diff

## When To Write A Rollout Note

Create or update a rollout note when:

- a non-trivial code change lands
- a design decision changes
- a blocker or caveat would slow down the next contributor
- verification produces an important failure or limitation
- a doc is replaced, split, or materially re-scoped

If the change is part of the same logical work item on the same day, update the
existing note instead of creating multiple tiny notes.

## Rollout Note Template

Use `docs/rollouts/_template.md` as the default template.

Required sections:

- `Summary`
- `Why`
- `Files`
- `Verification`
- `Follow-ups`

Optional sections:

- `Blockers`
- `Open Questions`
- `Replaced Docs`

## Writing Rules

- Prefer short factual bullets over narrative prose.
- Use exact file paths.
- Use exact commands for verification.
- Distinguish pre-existing failures from failures introduced by the change.
- Do not claim a behavior was verified unless the command or manual check was
  actually run.
- Never silently replace a design doc without recording that fact.

## Good Example

```md
# 2026-06-16 - strategy-panel-visibility

## Summary

- Added a visible strategy decision panel to the dashboard.

## Why

- Recommendations were previously buried in logs, which made the system appear
  inactive.

## Files

- `app/dashboard-client.tsx`
- `src/lib/strategy.ts`

## Verification

- `npx tsc --noEmit`
- `npm test`
- `npm run build`

## Follow-ups

- Add coverage for the empty-state message.
```
