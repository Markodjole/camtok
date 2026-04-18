import { notFound } from "next/navigation";
import { getLiveRoomDetail } from "@/actions/live-feed";
import { LiveRoomScreen } from "@/components/live/LiveRoomScreen";

export const dynamic = "force-dynamic";

export default async function LiveRoomPage({
  params,
}: {
  params: Promise<{ roomId: string }>;
}) {
  const { roomId } = await params;
  const { room } = await getLiveRoomDetail(roomId);
  if (!room) notFound();
  return <LiveRoomScreen initialRoom={room} />;
}
