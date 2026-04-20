import { getLiveFeed } from "@/actions/live-feed";
import { LiveFeedShell } from "@/components/live/LiveFeedShell";
import { AppShell } from "@/components/layout/app-shell";

export const dynamic = "force-dynamic";

export default async function LivePage() {
  const { items } = await getLiveFeed();
  return (
    <AppShell>
      <div className="flex h-full min-h-0 flex-col">
        <LiveFeedShell initialItems={items} />
      </div>
    </AppShell>
  );
}
