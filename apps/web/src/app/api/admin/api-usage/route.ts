import { type NextRequest, NextResponse } from "next/server";
import { getApiUsageReport } from "@/lib/usage/apiUsage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(req: NextRequest): boolean {
  const secret =
    process.env.USAGE_REPORT_SECRET ?? process.env.CRON_SECRET ?? "";
  if (!secret) {
    return process.env.NODE_ENV !== "production";
  }
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${secret}`;
}

/**
 * GET /api/admin/api-usage
 * Authorization: Bearer USAGE_REPORT_SECRET (or CRON_SECRET)
 */
export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  return NextResponse.json(getApiUsageReport(), {
    headers: { "Cache-Control": "no-store" },
  });
}
