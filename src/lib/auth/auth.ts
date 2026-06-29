// Auth.js v5 (next-auth@beta) configuration.
//
// Strategy: JWT sessions (stateless — no DB adapter needed). The `jwt` callback
// embeds the verified email into the token; the `session` callback exposes it to
// server components / route handlers that call `auth()`.
//
// Required env vars to ACTIVATE (see .env.example):
//   AUTH_SECRET        — openssl rand -base64 32
//   AUTH_GOOGLE_ID     — OAuth 2.0 client ID from Google Cloud Console
//   AUTH_GOOGLE_SECRET — OAuth 2.0 client secret
//   AUTH_GITHUB_ID     — GitHub OAuth App client ID
//   AUTH_GITHUB_SECRET — GitHub OAuth App client secret
//
// When these are NOT set the Auth.js path is simply never triggered (authConfigured
// returns false in middleware.ts and the primary-email fallback remains active).

import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import GitHub from "next-auth/providers/github";
import type { Account, Profile, Session, User } from "next-auth";
import type { JWT } from "next-auth/jwt";
import type { Provider } from "next-auth/providers";
import { normalizeAuthEmail, selectVerifiedGitHubEmail, type GitHubEmail } from "./github-email";
import { decodeSessionToken, encodeSessionToken } from "./session-token";

type EmailProfile = Profile & { email?: string | null };

const providers: Provider[] = [];

if (process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) {
  providers.push(
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET
    })
  );
}

if (process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET) {
  providers.push(
    GitHub({
      clientId: process.env.AUTH_GITHUB_ID,
      clientSecret: process.env.AUTH_GITHUB_SECRET,
      authorization: { params: { scope: "read:user user:email" } }
    })
  );
}

async function verifiedGitHubEmail(accessToken: string | undefined, fallbackEmail?: string | null): Promise<string | undefined> {
  if (!accessToken) return undefined;
  try {
    const response = await fetch("https://api.github.com/user/emails", {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "x-github-api-version": "2022-11-28"
      }
    });
    if (!response.ok) return undefined;
    const emails = (await response.json()) as GitHubEmail[];
    return selectVerifiedGitHubEmail(emails, fallbackEmail);
  } catch {
    return undefined;
  }
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  trustHost: true,
  providers,
  session: { strategy: "jwt" },
  jwt: {
    encode: encodeSessionToken,
    decode: decodeSessionToken
  },
  callbacks: {
    async signIn({ account, profile, user }: { account?: Account | null; profile?: EmailProfile; user?: User }) {
      if (account?.provider === "github") {
        const email = await verifiedGitHubEmail(account.access_token, user?.email ?? profile?.email);
        if (!email) return false;
        if (user) user.email = email;
      }
      return true;
    },
    // Persist the email in the JWT so it survives across requests without a DB lookup.
    async jwt({ token, user, account, profile }: { token: JWT; user?: User; account?: Account | null; profile?: EmailProfile }) {
      let email = normalizeAuthEmail(user?.email ?? profile?.email);
      if (account?.provider === "github" && !email) {
        email = await verifiedGitHubEmail(account.access_token, profile?.email);
      }
      if (email) {
        token.email = email;
      }
      return token;
    },
    // Expose the email on the `session` object returned by `auth()`.
    session({ session, token }: { session: Session; token: JWT }) {
      if (token.email && typeof token.email === "string") {
        session.user = session.user ?? {};
        session.user.email = token.email;
      }
      return session;
    }
  },
  pages: {
    signIn: "/login",
    error: "/access-denied"
  }
});
