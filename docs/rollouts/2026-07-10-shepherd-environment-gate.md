# 2026-07-10 - shepherd-environment-gate

## Summary

- Added a server-side branch gate to the `merge-shepherd` GitHub Actions workflow:
  created a GitHub **Environment** named `merge-shepherd` with a
  `deployment_branch_policy` locked to `main` (`custom_branch_policies: true`,
  branch policy `main` only, no other branches/tags), and wired
  `environment: merge-shepherd` into the `shepherd` job in
  `.github/workflows/merge-shepherd.yml`.
- Added `deployments: write` to the job's `permissions` allow-list (see Why).
- No application code changed - workflow YAML + docs only.
- Environment was created and its branch policy attached via the GitHub REST
  API (`gh api`), not through the Settings UI - both are idempotent and were
  re-run to confirm (repeat branch-policy POSTs did not create a duplicate
  entry; `GET .../deployment-branch-policies` still shows exactly one `main`
  policy).

## Why

- PR #1266 hardened the `shepherd` job with `if: github.ref ==
  'refs/heads/main'` so a `workflow_dispatch` against a non-main branch
  cannot run with `SHEPHERD_TOKEN`/`GITHUB_TOKEN`. That guard works, but it
  is YAML living inside the repo - a `workflow_dispatch` run against a
  non-main ref loads *that ref's* copy of the workflow file before any
  condition is evaluated, so in principle a branch could edit or remove the
  `if:` line itself. The `if:` guard is defense-in-depth, not a hard
  boundary.
- A GitHub Environment's `deployment_branch_policy` is enforced by GitHub's
  own deployment-gate logic before the job is even dispatched, and is
  configured via the Environments API/Settings UI - not something any
  branch's copy of the workflow file can edit. Attaching the job to an
  environment scoped to `main` closes the actual gap #1266 left open: even a
  `workflow_dispatch` whose *ref* is non-main, dispatched with a modified
  workflow file that deletes the `if:` guard entirely, still cannot get the
  job to run, because GitHub refuses to start a job against a protected
  environment from a non-allowed ref regardless of what the job's own YAML
  says.
- `deployments: write` was added to `permissions` because referencing
  `environment:` on a job makes GitHub track a deployment object (and
  deployment-status transitions) for each run, and this workflow already
  narrows `GITHUB_TOKEN` to an explicit allow-list - unlisted scopes default
  to `none`. Verified via GitHub's own docs/community discussion that
  environment protection rules (branch policy) are enforced by the platform
  independently of the job's own `permissions:` block (that block only
  governs what `GITHUB_TOKEN` can do inside `run:` steps), but the
  scope was added anyway as a belt-and-suspenders precaution against any
  deployment-status-update failure, since this is a live automation that
  actually merges PRs and a broken run would be a bad way to discover a gap.
  Considered `deployment: false` (skips creating the deployment record
  entirely, still grants environment secret access) but rejected it: GitHub's
  own docs flag `deployment: false` as "not compatible" with environments
  that have protection rules, and the exact interaction with
  `deployment_branch_policy` enforcement is not clearly documented - given
  the whole point of this change is to have the branch policy *enforced*,
  not possibly bypassed, the plain `environment: merge-shepherd` form (which
  unambiguously creates the deployment and is the documented primary use
  case for `deployment_branch_policy`) is the safer choice. The one
  side-effect is a `merge-shepherd` deployment entry will now show up in the
  repo's Environments/Deployments activity log for every run - cosmetic,
  not a functional issue.
- `SHEPHERD_TOKEN` was checked against the live repo secret list
  (`gh secret list`) and does not currently exist - the workflow's
  `secrets.SHEPHERD_TOKEN || secrets.GITHUB_TOKEN` fallback is presently
  just using `GITHUB_TOKEN`. There is nothing to migrate today. The
  GitHub API can create/configure an environment and its branch policy, but
  it cannot read or copy secret *values* - only an interactive owner action
  (`gh secret set SHEPHERD_TOKEN --env merge-shepherd` or the Settings UI)
  can set one. See Owner action below.

## Files

- `.github/workflows/merge-shepherd.yml` - added `environment: merge-shepherd`
  to the `shepherd` job (with an explanatory comment) and `deployments: write`
  to the job's `permissions` block; kept the existing `if:` guard unchanged.
- `docs/EFFORT-LOG.md` - added an In Progress row for this effort.
- `STATUS.md` - added a dated stanza for this effort.
- `docs/rollouts/2026-07-10-shepherd-environment-gate.md` - this note.

## GitHub-side state created (via `gh api`, not in this diff - server-side, not repo-tracked)

- `PUT /repos/jaywedgeworth22/Socratic.Trade/environments/merge-shepherd` with
  `deployment_branch_policy: {protected_branches: false, custom_branch_policies: true}`.
- `POST /repos/jaywedgeworth22/Socratic.Trade/environments/merge-shepherd/deployment-branch-policies`
  with `name: main`.
- Verified via `GET .../environments/merge-shepherd` (protection_rules includes one
  `branch_policy` rule) and `GET .../environments/merge-shepherd/deployment-branch-policies`
  (`total_count: 1`, `main` only) - confirmed idempotent by re-running the POST and
  re-checking the count stayed at 1.
- No required reviewers or wait timer were added to the environment - only the branch
  policy, so this does not add any human-approval friction to already-green armed-PR
  merges; it only narrows which *ref* the job can run against.

## Verification

- `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/merge-shepherd.yml'))"` -
  parses; also asserted `permissions.deployments == 'write'`,
  `jobs.shepherd.environment == 'merge-shepherd'`, and
  `jobs.shepherd.if == "github.ref == 'refs/heads/main'"` via a small inline
  `yaml.safe_load` check.
- `grep -nP '[^\x00-\x7F]' .github/workflows/merge-shepherd.yml` - only the
  pre-existing (untouched) line 5 em-dash; no new non-ASCII bytes introduced.
- `gh api repos/jaywedgeworth22/Socratic.Trade/environments/merge-shepherd` and
  `.../deployment-branch-policies` - confirmed server-side state matches intent
  (see above), and re-ran the POST once to confirm no duplicate branch-policy
  entries are created.
- No application/TypeScript source files were touched (workflow YAML + docs
  only), so `npx tsc --noEmit` / `npm test` / `npm run build` were not run in
  this Build phase per the delegating agent's instructions (focused
  verification only; the full `tsc`/`test`/`build` gate runs in the
  serialized Land phase via `scripts/land.sh`, which was deliberately NOT run
  here).
- Prepared on a fresh worktree detached from `origin/main`
  (`git worktree add --detach ... origin/main`, base commit `83ecfe26`),
  branch `claude/shepherd-environment-gate`, `git config user.email` confirmed
  resolving to the noreply address before any commit.

## Follow-ups

- **Owner action needed (cannot be done by the API/agent):** if/when
  `SHEPHERD_TOKEN` is ever set, set it as an **environment secret** scoped to
  `merge-shepherd` (`gh secret set SHEPHERD_TOKEN --env merge-shepherd --repo
  jaywedgeworth22/Socratic.Trade`, or Settings -> Environments ->
  merge-shepherd -> Environment secrets), not a repo-level secret. An
  environment secret is only readable by workflow runs that reference that
  environment, which layers the same branch-lock onto the secret itself. The
  API cannot read or copy an existing secret's value, so this step requires
  the owner (or an agent with the secret in hand per the secret-handoff
  protocol) to type/paste it once.
- Next `merge-shepherd` dispatch run (scheduled launchd trigger or manual
  `gh workflow run merge-shepherd.yml`) should be spot-checked to confirm the
  job still starts normally on `main` and that no deployment-status-update
  permission error appears in the run log, now that `environment:` and
  `deployments: write` are both new. Low risk (documented, standard GitHub
  Actions feature) but this workflow is a real production automation that
  merges PRs, so a first-run sanity check is worthwhile.
- This branch was prepared as instructed but was NOT landed by this agent -
  no `scripts/land.sh`, no PR opened, no merge, no deploy. Handing back
  ready-to-land for the serialized Land phase.

## Blockers

- None. Both GitHub-API steps (environment creation, branch-policy creation)
  succeeded on the first attempt with the current `gh auth` token (OAuth
  token scopes `admin:public_key, gist, read:org, repo`, and
  `repos/.../permissions` shows `admin: true` on this personal repo).
