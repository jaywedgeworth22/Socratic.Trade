// Minimal login page — redirects unauthenticated users here when authConfigured=true.
// When AUTH_GOOGLE_ID/SECRET are set, the "Sign in with Google" button triggers
// the Auth.js signIn flow. When Auth.js is not configured, this page is unreachable
// (middleware falls back to PRIMARY_EMAIL for all requests).

import { signIn } from "../../src/lib/auth/auth";

export const metadata = { title: "Sign in" };

// The Google auth is configured when AUTH_GOOGLE_ID is present.
const googleConfigured = !!(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);

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

        {googleConfigured ? (
          <form
            action={async () => {
              "use server";
              await signIn("google", { redirectTo: "/" });
            }}
          >
            <button
              type="submit"
              className="inline-flex items-center gap-2 rounded-md bg-accent px-5 py-2.5 text-sm font-medium text-accent-fg shadow-sm transition-opacity hover:opacity-90"
            >
              <GoogleIcon />
              Sign in with Google
            </button>
          </form>
        ) : (
          <div className="rounded-md border border-border bg-surface px-4 py-3 text-sm text-muted">
            <p>Auth provider not configured.</p>
            <p className="mt-1 text-xs">
              Set <code className="font-mono">AUTH_GOOGLE_ID</code> and{" "}
              <code className="font-mono">AUTH_GOOGLE_SECRET</code> to enable Google sign-in.
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
