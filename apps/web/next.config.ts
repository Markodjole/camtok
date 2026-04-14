import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["ffmpeg-static"],
  transpilePackages: [
    "@bettok/types",
    "@bettok/core",
    "@bettok/db",
    "@bettok/wallet",
    "@bettok/betting",
    "@bettok/story-engine",
    "@bettok/ui",
  ],
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**.supabase.co" },
      { protocol: "http", hostname: "127.0.0.1" },
    ],
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;
