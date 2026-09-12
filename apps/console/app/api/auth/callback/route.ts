import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const issuer = process.env.OIDC_ISSUER ?? "http://localhost:8080/realms/doot";
  const internalIssuer = process.env.OIDC_INTERNAL_ISSUER ?? issuer;
  const clientId = process.env.OIDC_CLIENT_ID ?? "doot-console";
  const state = request.nextUrl.searchParams.get("state");
  const code = request.nextUrl.searchParams.get("code");
  const expectedState = request.cookies.get("doot_oidc_state")?.value;
  const verifier = request.cookies.get("doot_oidc_verifier")?.value;
  if (!code || !state || state !== expectedState || !verifier) return NextResponse.redirect(new URL("/?auth=failed", request.url));
  const tokenResponse = await fetch(`${internalIssuer}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: `${request.nextUrl.origin}/api/auth/callback`,
      code,
      code_verifier: verifier
    })
  });
  if (!tokenResponse.ok) return NextResponse.redirect(new URL("/?auth=failed", request.url));
  const tokens = await tokenResponse.json() as { access_token: string; expires_in: number };
  const response = NextResponse.redirect(new URL("/", request.url));
  response.cookies.set("doot_access_token", tokens.access_token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: tokens.expires_in
  });
  response.cookies.delete("doot_oidc_verifier");
  response.cookies.delete("doot_oidc_state");
  return response;
}
