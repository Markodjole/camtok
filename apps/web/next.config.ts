import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /** Native binaries: keep resolvable at runtime on Vercel (do not bundle into webpack). */
  serverExternalPackages: ["ffmpeg-static", "ffprobe-static"],
  /**
   * Vercel file tracing does not follow dynamic `require()` into these packages, so the ~45MB
   * ffmpeg binary was missing at runtime (ENOENT). Explicit includes fix production.
   */
  outputFileTracingIncludes: {
    "/*": [
      "./node_modules/ffmpeg-static/**/*",
      "./node_modules/ffprobe-static/**/*",
    ],
  },
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
