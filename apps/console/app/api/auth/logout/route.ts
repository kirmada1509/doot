import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const response = NextResponse.redirect(new URL("/", process.env.CONSOLE_ORIGIN ?? request.url));
  response.cookies.delete("doot_access_token");
  return response;
}
