import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization,Content-Type,Accept,X-Requested-With,X-Client-Info,apikey",
  "Access-Control-Expose-Headers": "Content-Length,Content-Type",
  "Access-Control-Max-Age": "600",
  Vary: "Origin",
};

function applyCors(res: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  return res;
}

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const isApi = path.startsWith("/api/");

  if (isApi && request.method === "OPTIONS") {
    return applyCors(new NextResponse(null, { status: 204 }));
  }

  if (isApi) {
    return applyCors(NextResponse.next({ request }));
  }

  return await updateSession(request);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
