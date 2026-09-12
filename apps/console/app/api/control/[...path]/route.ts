import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const base = process.env.DOOT_API_INTERNAL_URL ?? "http://localhost:4000";
  const upstreamUrl = new URL(`${base.replace(/\/$/, "")}/${path.map(encodeURIComponent).join("/")}`);
  upstreamUrl.search = request.nextUrl.search;
  const headers = new Headers(request.headers);
  for (const key of ["host", "connection", "content-length", "transfer-encoding"]) headers.delete(key);
  const upstream = await fetch(upstreamUrl, {
    method: request.method,
    headers,
    ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: await request.arrayBuffer() }),
    redirect: "manual",
    cache: "no-store"
  });
  const responseHeaders = new Headers(upstream.headers);
  for (const key of ["connection", "content-length", "content-encoding", "transfer-encoding"]) responseHeaders.delete(key);
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
