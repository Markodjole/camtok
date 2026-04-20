"use client";

import { TopBar } from "./top-bar";
import { BottomNav } from "./bottom-nav";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-[100dvh] flex-col">
      <TopBar />
      <main className="min-h-0 flex-1 overflow-hidden pt-12 pb-16">{children}</main>
      <BottomNav />
    </div>
  );
}
