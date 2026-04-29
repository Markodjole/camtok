import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  logging: {
    incomingRequests: false,
  },
  // StrictMode double-mounts every useEffect in dev. With Supabase Realtime,
  // this creates two channels on the same topic; the first's unsubscribe
  // leaves the server-side topic subscription in a zombie state so the second
  // channel can SEND but not RECEIVE broadcasts. Disable to avoid this.
  reactStrictMode: false,
  outputFileTracingIncludes: {
    "/*": ["./bin/ffmpeg"],
  },
  transpilePackages: [
    "@bettok/types",
    "@bettok/core",
    "@bettok/db",
    "@bettok/wallet",
    "@bettok/betting",
    "@bettok/live",
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
