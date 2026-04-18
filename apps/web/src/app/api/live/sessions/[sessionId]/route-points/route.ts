import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import type { RoutePoint } from "@/actions/live-feed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await ctx.params;
  const service = await createServiceClient();

  const { data } = await service
    .from("live_route_snapshots")
    .select("normalized_lat,normalized_lng,raw_lat,raw_lng,heading_deg,speed_mps")
    .eq("live_session_id", sessionId)
    .order("recorded_at", { ascending: false })
    .limit(200);

  const points: RoutePoint[] = ((data ?? []) as Array<{
    normalized_lat: number | null;
    normalized_lng: number | null;
    raw_lat: number;
    raw_lng: number;
    heading_deg: number | null;
    speed_mps: number | null;
  }>)
    .map((s) => ({
      lat: s.normalized_lat ?? s.raw_lat,
      lng: s.normalized_lng ?? s.raw_lng,
      heading: s.heading_deg ?? undefined,
      speedMps: s.speed_mps != null ? Number(s.speed_mps) : undefined,
    }))
    .reverse();

  return NextResponse.json({ points });
}
