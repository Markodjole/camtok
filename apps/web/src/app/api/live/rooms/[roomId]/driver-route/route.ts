import { NextRequest, NextResponse } from "next/server";
import { computeDriverRouteInstruction } from "@/lib/live/routing/computeDriverRouteInstruction";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await ctx.params;
  const out = await computeDriverRouteInstruction(roomId);
  return NextResponse.json(out);
}
