import { NextRequest, NextResponse } from "next/server";
import { inferLeadVehicleForUser } from "@/actions/live-lead-vehicle-infer";
import { getBearerUser } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await ctx.params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const bearerUser = await getBearerUser(req);
  if (!bearerUser) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const res = await inferLeadVehicleForUser(bearerUser.id, {
    sessionId,
    timestampMs:
      typeof body.timestampMs === "number" ? body.timestampMs : Date.now(),
    frameWidth: body.frameWidth,
    frameHeight: body.frameHeight,
    rotationDegrees: body.rotationDegrees,
    roundId: body.roundId,
    imageBase64: body.imageBase64,
  });

  if ("error" in res) {
    const status =
      res.error === "forbidden"
        ? 403
        : res.error === "session_not_found"
          ? 404
          : 400;
    return NextResponse.json({ error: res.error }, { status });
  }

  return NextResponse.json(res);
}
