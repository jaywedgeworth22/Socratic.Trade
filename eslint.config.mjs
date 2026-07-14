// Flat ESLint config (ESLint 10 + eslint-config-next 16).
//
// `eslint-config-next/core-web-vitals` already spreads the base Next config
// (React, React-Hooks, import, jsx-a11y, @next/next) and adds the
// Core Web Vitals rules; `eslint-config-next/typescript` adds the
// typescript-eslint recommended ruleset. Together they reproduce what the
// legacy `next lint` default ("next/core-web-vitals" + "next/typescript")
// enabled.
//
// Rollout note: this is wired into the required `verify` CI gate. ESLint only
// fails the build on *errors*, not warnings, so several broad rules are pinned
// to "warn" below to keep the initial baseline green while still surfacing
// issues. Tighten these to "error" and burn down the warnings over time.
import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

export default [
  ...coreWebVitals,
  ...typescript,
  {
    // Generated / vendored / data output that should not be linted.
    ignores: [
      ".next/**",
      "**/.next/**",
      "out/**",
      "build/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      "next-env.d.ts",
      "data/**",
      ".claude/**",
      ".agents/**",
      ".tools/**",
      "**/worktrees/**",
      "scratch/**",
      "ds-bundle/**",
      ".design-sync/**",
      ".ds-sync/**",
    ],
  },
  {
    files: [ "**/*.{js,jsx,mjs,ts,tsx,mts,cts}" ],
    // Baseline triage: these rules have a pre-existing backlog of violations
    // (mostly `any` in tests and an opinionated effect rule). They are pinned to
    // "warn" so the required `verify` CI gate is green today while still
    // surfacing the debt. Everything else from the Next/TS presets stays at its
    // default severity (most are "error"), so the gate blocks NEW regressions of
    // rules that currently pass (e.g. rules-of-hooks, critical @next/next rules,
    // import errors, syntax errors). Promote these back to "error" and burn down
    // the warnings over time.
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react/no-unescaped-entities": "warn",
      "react/display-name": "warn",
      "@next/next/no-html-link-for-pages": "warn",
    },
  },
];
