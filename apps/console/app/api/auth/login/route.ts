import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const issuer = process.env.OIDC_ISSUER ?? "http://localhost:8080/realms/doot";
  const clientId = process.env.OIDC_CLIENT_ID ?? "doot-console";
  const origin = process.env.CONSOLE_ORIGIN ?? new URL(request.url).origin;
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(24).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL(`${issuer}/protocol/openid-connect/auth`);
  authorize.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${origin}/api/auth/callback`,
    response_type: "code",
    scope: "openid profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256"
  }).toString();
  const response = NextResponse.redirect(authorize);
  const cookieOptions = { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge: 600 };
  response.cookies.set("doot_oidc_verifier", verifier, cookieOptions);
  response.cookies.set("doot_oidc_state", state, cookieOptions);
  return response;
}
