import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Proxy for traffic camera snapshot images.
 * DOT servers rarely set CORS headers, so we fetch server-side and stream back.
 */
export async function GET(req: NextRequest) {
  const rawUrl = req.nextUrl.searchParams.get("url");
  if (!rawUrl) {
    return new NextResponse("Missing url", { status: 400 });
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(rawUrl);
  } catch {
    return new NextResponse("Invalid url", { status: 400 });
  }

  // Allowlist: only proxy http(s) URLs from known DOT / 511 domains.
  if (targetUrl.protocol !== "https:" && targetUrl.protocol !== "http:") {
    return new NextResponse("Disallowed protocol", { status: 400 });
  }

  try {
    const upstream = await fetch(targetUrl.toString(), {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; CamtokTrafficBot/1.0)",
        Accept: "image/jpeg,image/png,image/*",
      },
      // Short TTL — camera images refresh every 30-120 s.
      next: { revalidate: 25 },
    });

    if (!upstream.ok) {
      return new NextResponse("Upstream error", { status: 502 });
    }

    const contentType = upstream.headers.get("content-type") ?? "image/jpeg";
    const buffer = await upstream.arrayBuffer();

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=25, stale-while-revalidate=10",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    console.warn("[camera-image-proxy] error", err);
    return new NextResponse("Proxy error", { status: 502 });
  }
}
