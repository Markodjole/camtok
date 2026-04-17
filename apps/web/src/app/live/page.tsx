import { getLiveFeed } from "@/actions/live-feed";
import { LiveFeedList } from "@/components/live/LiveFeedList";
import { AppShell } from "@/components/layout/app-shell";

export const dynamic = "force-dynamic";

export default async function LivePage() {
  const { items } = await getLiveFeed();
  return (
    <AppShell>
      <div className="mx-auto h-full max-w-md overflow-y-auto">
        <header className="px-4 pb-2 pt-4">
          <h1 className="text-2xl font-semibold">Live now</h1>
          <p className="text-sm text-muted-foreground">
            Real people, live cameras, live routes — bet on what they do next.
          </p>
        </header>
        <LiveFeedList initialItems={items} />
      </div>
    </AppShell>
  );
}
