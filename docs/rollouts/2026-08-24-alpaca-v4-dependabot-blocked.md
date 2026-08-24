# 2026-08-24 — Alpaca-trade-api v4 dependabot bump blocked (PR #3077)

## Context & Objective

Dependabot opened PR #3077 to bump `@alpacahq/alpaca-trade-api` from 3.1.3 to
4.0.1 (semver-major).  The Codex PR reviewer flagged P1 issues on the Alpaca
quote parser and order mapper reading v3 wire keys.  This note records what
the autofix round found: v4 is a complete SDK rewrite, the adapter is built on
the v3 flat client surface, and the PR cannot build until the adapter is
migrated or the bump is reverted — an owner decision, not an autofix guess.

## Changes Made

No product code was changed this round.  The work was verification plus
handoff-docs updates:

- Verified that `@alpacahq/alpaca-trade-api@4.0.1` ships **no default export**
  (named `Alpaca` only), so `import Alpaca from "@alpacahq/alpaca-trade-api"`
  at `src/lib/alpaca.ts:1` fails `tsc` with `TS2613`.
- Verified the v4 `Alpaca` class exposes only `paper`, `trading`, and
  `marketData`/`data` accessors — the flat v3 methods the adapter calls
  (`getAccount`, `getOrders`, `getLatestQuotes`, `createOrder`, `cancelOrder`,
  `sendRequest`, `getPositions`, `closePosition`) no longer exist.  At runtime
  `new Alpaca(options)` would be `undefined` (default import), so the gateway
  is broken end-to-end, not just in the parser.
- Confirmed the Codex P1 threads are symptoms of one migration, not isolated
  bugs: the quote parser (`src/lib/alpaca.ts:693-707`, `bp`/`ap`/`t`) and the
  order mapper (`mapAlpacaOrder`, `src/lib/alpaca.ts:1086-1107`,
  `client_order_id`/`filled_qty`/`created_at`) are on the same flat v3 surface
  as every other call in the 1144-line adapter.
- Merged `origin/main` into the PR branch (4 dependabot commits; clean merge)
  and re-ran `npm install` so the branch is current while it awaits a decision.
- Updated `STATUS.md` and `docs/EFFORT-LOG.md` with the blocker (owner
  decision: migrate to v4 vs retain v3).

## Decisions & Trade-offs

- **Did not guess at the migration.**  `src/lib/alpaca.ts` is the real-money
  broker adapter; migrating it to v4's `trading.*`/`marketData.*` namespaces
  plus the camelCase response model touches order placement, reconciliation,
  quotes, positions, and every test fixture that feeds v3 shapes
  (`test/alpaca-brackets.test.ts`, `test/alpaca-order-mapping.test.ts`,
  `test/alpaca-mcp.test.ts`, `test/data-providers.test.ts`).  That is
  architecturally significant and belongs on a deliberate branch, not an
  autofix round against a dependabot PR.
- **Did not revert the bump.**  Retaining v3 is the reviewer's own fallback
  option, but flipping the PR's entire purpose without the owner's call would
  be a guess too.  The owner decides.
- Left the quote-parsing and order-parsing Codex threads **open** (a question
  was posted to the maintainer).  Resolved only the handoff-docs thread, which
  this round addresses.
- Did not enable auto-merge: the PR is not functional (build broken), so the
  "address actionable items then auto-merge" gate does not apply.

## Verification State

- `npx tsc --noEmit` → **FAILS** (pre-existing, caused by the dependabot bump):
  `src/lib/alpaca.ts(1,8): error TS2613 ... has no default export`.
- `npm test` and `npm run build` were not run to completion because the type
  gate fails first; the failure is in the dependency bump, not this round's
  doc changes.
- `git merge origin/main` clean; `npm install` exit 0.

## Next Steps & Blockers

- **Blocker:** owner decision on PR #3077 — either
  (a) migrate `src/lib/alpaca.ts` + fixtures to the v4 namespace API, or
  (b) revert the bump and retain v3.
- If (a): the migration must cover the import style (`import { Alpaca }`),
  every `this.alpaca.*` call site, the camelCase response mappers
  (`getLatestQuotes` → `bidPrice`/`askPrice`/`timestamp`; order/position
  mappers → camelCase), the `sendRequest` replacement, and the test fixtures.
- The Codex threads on quote/order parsing stay open until the owner picks a
  direction; the handoff-docs thread is resolved.

## Zero-Code Findings

The dependabot v4 bump is unmergeable without an adapter migration.  The two
P1 parsing threads describe real breakage, but they are the visible surface of
a full SDK rewrite — there is no safe partial fix that keeps the build green
and the runtime correct.

## Round 2 (2026-08-24, second Codex review of head `a8501b7f`)

### Context & Objective

Codex re-reviewed the autofix head and posted three more P1 threads.  All of
them were re-checked against the current branch; two are further symptoms of
the same v4 migration and one is a false positive against the branch state.

### New Threads Assessed

- **Account parsing (P1).**  The account paths (`src/lib/alpaca.ts:443-550`,
  `getPortfolio`, the order-capability probe) read v3 snake-case wire keys
  (`account.account_number`, `account.portfolio_value`, `account.buying_power`,
  `account.trading_blocked`, `account.account_blocked`, `account.status`,
  `account.equity`, `account.cash`).  v4 returns these camelCase
  (`accountNumber`, `portfolioValue`, `buyingPower`, `tradingBlocked`, …), so
  the values collapse to zero/false and the account-mismatch probe sees no live
  number.  Real finding — same migration, not an isolated bug.
- **Position cost-basis parsing (P1).**  `parseAlpacaPosition`
  (`src/lib/alpaca.ts:1109-1117`) reads `p.avg_entry_price` /
  `p.average_entry_price` / `p.averageCost`; v4's canonical field is
  `avgEntryPrice`, so every v4 holding gets an average cost of zero and the
  add-to-loser / take-profit risk checks early-return.  Real finding — same
  migration.
- **Commit identity (P1).**  The thread claims a commit is authored/committed
  as `Codex <codex@openai.com>`.  Verified false against the branch: every
  commit in the PR range (`96812ee6`, `c5eef35b`, `1a9f79b2`, `a8501b7f`) is
  `dependabot[bot]` or `claude[bot]`; `a8501b7f` uses the owner noreply.  No
  history rewrite was performed (force-push for a non-existent identity would
  be destructive and pointless).

### Changes Made (Round 2)

No product code was changed.  The branch was re-merged with `origin/main`
(`cd22194e` jose bump, clean merge) and `npm install` re-run (exit 0).  This
note and `STATUS.md` / `docs/EFFORT-LOG.md` were updated to record the new
threads and the outstanding owner decision.

### Verification State (Round 2)

- `npx tsc --noEmit` → **FAILS** (pre-existing, same spot):
  `src/lib/alpaca.ts(1,8): error TS2613 ... has no default export`.  The merge
  added no new type errors (the jose bump is unrelated and type-clean).
- Targeted Alpaca fixtures all **PASS** with v4 installed:
  `test/alpaca-brackets.test.ts`, `test/alpaca-order-mapping.test.ts` (27/27),
  `test/alpaca-mcp.test.ts`, `test/data-providers.test.ts` (148 passed / 9
  skipped) — the fixtures exercise the `TestBrokerGateway`/mock surface, not
  the real v4 client, which is why they do not catch the default-import break.
- Full `npm test` suite was started; the 10-minute ceiling was hit before the
  suite finished in this environment (unrelated to this PR's doc changes; the
  type gate fails first regardless).

### Decisions & Trade-offs (Round 2)

- Still **did not guess at the migration** and **did not revert the bump**.
  The owner decision request from Round 1 (and the owner's own 08:27Z comment)
  is still open; the new parsing threads reinforce it rather than change it.
- Left all five Codex threads open (quote, order, account, position, identity):
  the parsing threads stay open pending the owner's migrate-vs-revert call, and
  the identity thread stays open because it was not actionably true.  No
  auto-merge: the PR is not functional.

### Next Steps & Blockers (Round 2)

Same as Round 1: owner decision (migrate adapter + fixtures to v4 vs revert to
v3).  No new actionable autofix work exists until that call is made.
