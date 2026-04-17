import { NextRequest, NextResponse } from "next/server";
import { placeLiveBet } from "@/actions/live-markets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  _ctx: { params: Promise<{ roomId: string }> },
) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const res = await placeLiveBet(body as Parameters<typeof placeLiveBet>[0]);
  if ("error" in res) {
    return NextResponse.json({ error: res.error }, { status: 400 });
  }
  return NextResponse.json(res);
}
