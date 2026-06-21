# CI workflows (staged — not activated)

These workflow definitions are staged here instead of `.github/workflows/` because the
current git push credential lacks the GitHub OAuth `workflow` scope (pushing files under
`.github/workflows/` is rejected without it). To activate CI, move them with a
workflow-scoped token:

    git mv ci-pending/ci.yml ci-pending/e2e.yml ci-pending/security.yml .github/workflows/
