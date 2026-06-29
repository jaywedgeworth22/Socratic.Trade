// Minimal login page — redirects unauthenticated users here when authConfigured=true.
// Configured Auth.js providers render as sign-in buttons. When Auth.js is not
// configured, this page is unreachable (middleware falls back to PRIMARY_EMAIL).

import type { ReactNode } from "react";
import { signIn } from "../../src/lib/auth/auth";

export const metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

const googleConfigured = !!(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);
const githubConfigured = !!(process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET);

const providers = [
  googleConfigured ? { id: "google", label: "Sign in with Google", icon: <GoogleIcon />, className: "bg-accent text-accent-fg" } : null,
  githubConfigured ? { id: "github", label: "Sign in with GitHub", icon: <GitHubIcon />, className: "bg-fg text-bg" } : null
].filter(Boolean) as Array<{ id: string; label: string; icon: ReactNode; className: string }>;

export default function LoginPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-bg px-6 text-center">
      <div className="max-w-md space-y-6">
        <div className="space-y-2">
          <h1 className="text-xl font-semibold text-fg">Sign in to the dashboard</h1>
          <p className="text-sm text-muted">
            Authentication is required to access this app.
          </p>
        </div>

        {providers.length > 0 ? (
          <div className="space-y-3">
            {providers.map((provider) => (
              <form
                key={provider.id}
                action={async () => {
                  "use server";
                  await signIn(provider.id, { redirectTo: "/" });
                }}
              >
                <button
                  type="submit"
                  className={`${provider.className} inline-flex min-w-52 items-center justify-center gap-2 rounded-md px-5 py-2.5 text-sm font-medium shadow-sm transition-opacity hover:opacity-90`}
                >
                  {provider.icon}
                  {provider.label}
                </button>
              </form>
            ))}
          </div>
        ) : (
          <div className="rounded-md border border-border bg-surface px-4 py-3 text-sm text-muted">
            <p>Auth provider not configured.</p>
            <p className="mt-1 text-xs">
              Set Google or GitHub Auth.js credentials to enable sign-in.
            </p>
          </div>
        )}

        <p className="text-xs text-muted">
          Access is restricted. Contact the owner if you need an account.
        </p>
      </div>
    </main>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615Z"
        fill="#4285F4"
      />
      <path
        d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18Z"
        fill="#34A853"
      />
      <path
        d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332Z"
        fill="#FBBC05"
      />
      <path
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58Z"
        fill="#EA4335"
      />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2.1c-3.2.7-3.87-1.37-3.87-1.37-.52-1.32-1.27-1.67-1.27-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.68 1.24 3.33.95.1-.74.4-1.24.73-1.53-2.56-.29-5.25-1.28-5.25-5.7 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.05 0 0 .96-.31 3.16 1.18A10.96 10.96 0 0 1 12 6.05c.98 0 1.96.13 2.88.39 2.19-1.49 3.15-1.18 3.15-1.18.63 1.59.24 2.76.12 3.05.74.81 1.18 1.84 1.18 3.1 0 4.43-2.7 5.41-5.26 5.69.41.35.78 1.05.78 2.13v3.12c0 .31.21.67.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}
