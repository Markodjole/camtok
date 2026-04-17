"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  Radio,
  Plus,
  Wallet,
  Users,
  User,
} from "lucide-react";

const navItems = [
  { href: "/live", label: "Live", icon: Radio },
  { href: "/bets", label: "Bets", icon: Wallet },
  { href: "/create", label: "Create", icon: Plus, accent: true },
  { href: "/characters", label: "Characters", icon: Users },
  { href: "/profile", label: "Profile", icon: User },
];

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 border-t border-border bg-background/95 backdrop-blur-lg safe-bottom">
      <div className="mx-auto flex h-16 max-w-lg items-center">
        {navItems.map((item) => {
          const isActive = pathname.startsWith(item.href);
          const Icon = item.icon;

          if (item.accent) {
            if (isActive) {
              return (
                <div
                  key={item.href}
                  aria-disabled="true"
                  className="flex flex-1 flex-col items-center justify-center"
                >
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/70 shadow-[0_10px_24px_-8px_rgba(124,58,237,0.65)] ring-2 ring-primary/30">
                    <Icon className="h-6 w-6 text-primary-foreground" />
                  </div>
                </div>
              );
            }

            return (
              <Link
                key={item.href}
                href={item.href}
                className="flex flex-1 flex-col items-center justify-center"
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary shadow-[0_10px_24px_-8px_rgba(124,58,237,0.65)] ring-2 ring-primary/30">
                  <Icon className="h-6 w-6 text-primary-foreground" />
                </div>
              </Link>
            );
          }

          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex flex-1 flex-col items-center justify-center gap-0.5 py-1 transition-colors",
                isActive ? "text-primary" : "text-muted-foreground"
              )}
            >
              <Icon className="h-5 w-5 shrink-0" />
              <span className="text-[10px] font-medium">{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
