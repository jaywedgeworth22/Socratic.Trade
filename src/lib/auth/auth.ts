// Auth.js v5 (next-auth@beta) configuration.
//
// Strategy: JWT sessions (stateless — no DB adapter needed). The `jwt` callback
// embeds the verified email into the token; the `session` callback exposes it to
// server components / route handlers that call `auth()`.
//
// Required env vars to ACTIVATE (see .env.example):
//   AUTH_SECRET        — openssl rand -base64 32
//
// Optional OAuth providers (at least one required for sign-in):
//   AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET — Google Cloud Console OAuth 2.0 client
//   AUTH_GITHUB_ID / AUTH_GITHUB_SECRET — GitHub OAuth App (Settings → Developer)
//
// When AUTH_SECRET is NOT set the Auth.js path is simply never triggered
// (authConfigured returns false in middleware.ts and the primary-email fallback
// remains active).

import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import GitHub from "next-auth/providers/github";
import type { JWT } from "next-auth/jwt";
import type { Session } from "next-auth";
import { decodeSessionToken, encodeSessionToken } from "./session-token";

const providers = [];
if (process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) {
  providers.push(Google({ clientId: process.env.AUTH_GOOGLE_ID, clientSecret: process.env.AUTH_GOOGLE_SECRET }));
}
if (process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET) {
  providers.push(GitHub({ clientId: process.env.AUTH_GITHUB_ID, clientSecret: process.env.AUTH_GITHUB_SECRET }));
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
    // Persist the email in the JWT so it survives across requests without a DB lookup.
    jwt({ token, profile }: { token: JWT; profile?: { email?: string | null } }) {
      if (profile?.email) {
        token.email = profile.email.trim().toLowerCase();
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
