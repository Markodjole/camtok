import { NextResponse } from "next/server";
import { getLiveFeed } from "@/actions/live-feed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const res = await getLiveFeed();
  return NextResponse.json(res);
}
