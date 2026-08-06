---
name: codex-triage
description: Triage unresolved review threads from codex-connector bot on a PR -- classify findings, fix in one batch, then reply and resolve. Invoke when gating a merge.
---

# Codex-Connector Review Thread Triage

## Procedure

1. **Fetch unresolved threads with full context.** Substitute PR number `<N>`:
```bash
gh api graphql -f query='query{repository(owner:"jaywedgeworth22",name:"Socratic.Trade"){pullRequest(number:<N>){reviewThreads(first:100){nodes{id isResolved path line comments(first:10){nodes{author{login} body diffHunk}}}}}}}' --jq '.data.repository.pullRequest.reviewThreads.nodes | map(select(.isResolved==false))'
```

2. **Classify each thread against current branch HEAD** -- not the stale hunk in the comment. Three categories only:
   - **addressed** -- fixed in a recent commit on this branch.
   - **false_positive** -- bot misread context, or rule does not apply to this codebase.
   - **real** -- finding is valid. For money-path files (`src/lib/db*.ts`, `src/lib/execution*.ts`, `src/lib/performance.ts`, `src/lib/policy.ts`), have a second agent adversarially verify before acting.

3. **Fix all real findings in one batch.** Commit with a regression test per behavior change. Push the commit before resolving any threads (race condition in step 5).

4. **Reply to each thread, then resolve.** Do NOT resolve without a reply first.

   Reply (substitute `<threadId>` and `<text>`):
```bash
gh api graphql -f query='mutation($t:ID!,$b:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$t,body:$b}){comment{id}}}' -F t=<threadId> -f b=<text>
```

   Reply format: **Real findings:** "Fixed in <short-sha>. [Function refs]. [Test added: test/foo.test.ts]." (1-3 sentences, factual, no hedging.)
   **False positives:** Brief reason why the rule does not apply here, then resolve.

   Resolve (substitute `<threadId>`):
```bash
gh api graphql -f query='mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}' -F t=<threadId>
```

5. **THE AUTO-MERGE RACE.** The instant the final thread resolves and CI is green, auto-merge fires. The bot re-reviews every push and never converges. Consequence:
   - Resolving the last thread = merging the PR. Triple-check first.
   - Round-2 findings often land on an already-merged PR. Before resolving any thread as "fixed," verify the fix reached main:
```bash
git merge-base --is-ancestor <fix-sha> origin/main && echo "on main" || echo "NOT on main"
```
   If NOT on main, open a follow-up PR from the same branch (expect merge conflicts from squash -- merge main in, this branch's newer rounds win in its own files).

6. **Stop at round 2-3.** Later rounds are noise on a merged PR. Triage only for genuine hazards; surface the rest to the owner.

## Canon (source of truth -- read these if anything conflicts)

- **Pre-Commit / Handoff Protocol:** `AGENTS.md`
- **Codex triage decision history:** memory `codex-review-loop`
- **Auto-merge race + follow-up pattern:** `docs/rollouts/2026-07-09-monet-usage-cap-pickup.md`
