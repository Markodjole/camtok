import { NextRequest, NextResponse } from "next/server";
import { getLeadVehicleOverlayState } from "@/actions/live-lead-vehicle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await ctx.params;
  if (!sessionId) {
    return NextResponse.json({ error: "missing_session" }, { status: 400 });
  }
  const state = await getLeadVehicleOverlayState(sessionId);
  return NextResponse.json(
    { state },
    {
      headers: {
        "Cache-Control": "public, s-maxage=0, stale-while-revalidate=1",
      },
    },
  );
}
