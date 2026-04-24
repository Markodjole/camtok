import { NextRequest, NextResponse } from "next/server";
import {
  ingestLocationBatch,
  ingestLocationBatchForUser,
} from "@/actions/live-location";
import { locationBatchInputSchema } from "@bettok/live";
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
  const parsed = locationBatchInputSchema.safeParse({ ...body, sessionId });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const bearerUser = await getBearerUser(req);
  const res = bearerUser
    ? await ingestLocationBatchForUser(bearerUser.id, parsed.data)
    : await ingestLocationBatch(parsed.data);

  if ("error" in res) {
    const status = res.error === "Not authenticated" ? 401 : 400;
    return NextResponse.json({ error: res.error }, { status });
  }
  return NextResponse.json(res);
}
