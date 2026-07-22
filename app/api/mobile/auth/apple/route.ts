import { NextResponse } from "next/server";
import { jwtVerify, createRemoteJWKSet } from "jose";
import { isEmailAllowed } from "../../../../../src/lib/auth/identity";
import { encodeSessionToken } from "../../../../../src/lib/auth/session-token";
import { resolveAppleClientId } from "../../../../../src/lib/auth/apple-client-id";

export async function POST(request: Request) {
  try {
    const { identityToken, name } = await request.json();

    if (!identityToken || typeof identityToken !== "string") {
      return NextResponse.json({ error: "Missing or invalid identityToken" }, { status: 400 });
    }

    // 1. Verify the Apple identity token
    const JWKS = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));
    const { payload } = await jwtVerify(identityToken, JWKS, {
      issuer: "https://appleid.apple.com",
      // We accept the iOS App Bundle ID. You must set APPLE_CLIENT_ID or we use the known app id.
      audience: resolveAppleClientId()
    });

    const email = payload.email as string | undefined;
    if (!email) {
      return NextResponse.json({ error: "Apple token did not contain an email address." }, { status: 400 });
    }

    // 2. Authorize the user (allowed list check)
    if (!isEmailAllowed(email)) {
      return NextResponse.json({ error: "Access denied." }, { status: 403 });
    }

    // 3. Mint a session token
    const authSecret = process.env.AUTH_SECRET;
    if (!authSecret) {
      console.error("AUTH_SECRET is missing");
      return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }

    const salt = process.env.NODE_ENV === "production" ? "__Secure-authjs.session-token" : "authjs.session-token";
    
    // Pass the same fields Auth.js would typically pack in the JWT
    const sessionJwt = await encodeSessionToken({
      // Explicit provider-login time is preserved across rolling JWT refreshes. Request identity
      // uses it to select a post-deletion account generation without freeing older mobile tokens.
      token: { email, name: name ?? payload.email, loginAt: Date.now() },
      secret: authSecret,
      salt
    });

    // 4. Return the session cookie
    const response = NextResponse.json({ success: true, email });
    const maxAge = 30 * 24 * 60 * 60; // 30 days
    response.cookies.set(salt, sessionJwt, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge
    });

    return response;
  } catch (error) {
    console.error("Apple Sign-In Verification Error:", error);
    return NextResponse.json({ error: "Invalid identity token" }, { status: 401 });
  }
}
