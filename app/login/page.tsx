// Minimal login page — redirects unauthenticated users here when authConfigured=true.
// Supports Google, GitHub, and/or Apple OAuth. When neither Auth.js nor CF Access is
// configured, this page is unreachable (middleware falls back to PRIMARY_EMAIL).
//
// force-dynamic: provider availability is read from process.env at request time so
// secrets injected after build (e.g. via Infisical at start:secrets) are reflected
// immediately without a rebuild.

import { isAppleWebAuthConfigured } from "../../src/lib/auth/apple-web";
import { signIn } from "../../src/lib/auth/auth";
import { SENTENCE_GAP } from "../console/lib/format";
import { HeaderLogo } from "../console/ui/header-logo";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

const googleConfigured = !!(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);
const githubConfigured = !!(process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET);
const appleConfigured = isAppleWebAuthConfigured();
const anyProviderConfigured = googleConfigured || githubConfigured || appleConfigured;

/** Value props — keep in sync with iOS LoginView feature bullets. */
const LOGIN_VALUE_BULLETS = [
  "Configure framework and guardrails",
  "Review and approve proposals",
  "Track positions, orders, and performance",
  "Control the backend agent without moving credentials onto the device"
] as const;

/**
 * One light pill for every provider.  Owner 2026-08-21: match the white
 * "Continue with Google" treatment (solid white, hairline border, soft shadow,
 * icon + label grouped in the middle) and use the same monochrome mark style
 * for Google, GitHub, and Apple.  Do not add email/password.  Keep in sync
 * with `providerButton` in `ios/SocraticTrade/LoginView.swift`.
 */
const PROVIDER_BUTTON_CLASS =
  "inline-flex w-full min-h-11 items-center justify-center gap-3 rounded-full border border-line-strong bg-white px-5 text-sm font-medium text-fg shadow-sm transition-colors hover:bg-black/[0.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 dark:border-line-strong dark:bg-surface dark:text-fg dark:hover:bg-white/[0.06]";

export default function LoginPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-bg px-6 text-center">
      <div className="w-full max-w-md space-y-6">
        <div className="flex justify-center mb-2 px-4 overflow-hidden">
          <HeaderLogo height={30} />
        </div>

        <ul className="mx-auto max-w-sm space-y-2.5 rounded-md border border-line bg-surface px-4 py-3.5 text-left">
          {LOGIN_VALUE_BULLETS.map((text) => (
            <li key={text} className="flex items-start gap-2.5 text-sm text-fg">
              <span
                className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                aria-hidden
              />
              <span className="leading-snug">{text}</span>
            </li>
          ))}
        </ul>

        {anyProviderConfigured ? (
          <div className="flex flex-col gap-3">
            {googleConfigured && (
              <form
                action={async () => {
                  "use server";
                  await signIn("google", { redirectTo: "/" });
                }}
              >
                <button type="submit" className={PROVIDER_BUTTON_CLASS}>
                  <GoogleIcon />
                  Sign in with Google
                </button>
              </form>
            )}
            {githubConfigured && (
              <form
                action={async () => {
                  "use server";
                  await signIn("github", { redirectTo: "/" });
                }}
              >
                <button type="submit" className={PROVIDER_BUTTON_CLASS}>
                  <GitHubIcon />
                  Sign in with GitHub
                </button>
              </form>
            )}
            {appleConfigured && (
              <>
                <form
                  action={async () => {
                    "use server";
                    await signIn("apple", { redirectTo: "/" });
                  }}
                >
                  <button type="submit" className={PROVIDER_BUTTON_CLASS}>
                    <AppleIcon />
                    Sign in with Apple
                  </button>
                </form>
                {!googleConfigured && !githubConfigured && (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    Apple is your only sign-in method.  Apple only sends your email on first
                    authorization — if your session expires, you will need to add Google or
                    GitHub as a fallback to sign back in.
                  </p>
                )}
              </>
            )}
          </div>
        ) : (
          <div className="rounded-md border border-line bg-surface px-4 py-3 text-sm text-muted">
            <p>Auth provider not configured.</p>
            <p className="mt-1 text-xs">
              Set <code className="font-mono">AUTH_GOOGLE_ID</code> /{" "}
              <code className="font-mono">AUTH_GOOGLE_SECRET</code> for Google,{" "}
              <code className="font-mono">AUTH_GITHUB_ID</code> /{" "}
              <code className="font-mono">AUTH_GITHUB_SECRET</code> for GitHub, or{" "}
              <code className="font-mono">AUTH_APPLE_ID</code> /{" "}
              <code className="font-mono">AUTH_APPLE_SECRET</code> for Apple sign-in.
            </p>
          </div>
        )}

        <div className="space-y-2">
          <p className="text-xs text-muted leading-relaxed">
            By signing in, you agree to the Terms and Privacy Policy linked below.
            {SENTENCE_GAP}AI generated proposals, behaviors, and actions are not guaranteed
            though strategic framework is customizable and defined by each user.
            {SENTENCE_GAP}Site and app do not provide financial or investment advice and were
            made for educational, experimental, and/or informational use only.
          </p>
          <p className="flex justify-center gap-4 text-xs">
            <a href="/terms-and-conditions" className="underline underline-offset-2 hover:text-fg">
              Terms
            </a>
            <a href="/privacy-policy" className="underline underline-offset-2 hover:text-fg">
              Privacy
            </a>
          </p>
        </div>
      </div>
    </main>
  );
}

function GoogleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 18 18" aria-hidden="true" fill="currentColor" className="shrink-0">
      <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615Z" />
      <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18Z" />
      <path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332Z" />
      <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58Z" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor" className="shrink-0">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.385-1.335-1.755-1.335-1.755-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 21.795 24 17.295 24 12c0-6.63-5.37-12-12-12Z" />
    </svg>
  );
}

function AppleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor" className="shrink-0">
      <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
    </svg>
  );
}
