import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // pnpm uses symlinks; without this, Vercel packages symlinks instead of real files.
  outputFileTracingRoot: path.resolve(__dirname, "../.."),
  /** Native binary: keep resolvable at runtime on Vercel (do not bundle into webpack). */
  serverExternalPackages: ["ffmpeg-static"],
  /**
   * Vercel file tracing does not follow the static import target reliably; include the real
   * binary plus package entrypoints. Avoid broad glob includes on huge dependency trees — that
   * exceeds the 250MB unzipped serverless limit.
   */
  outputFileTracingIncludes: {
    "/*": [
      "./node_modules/ffmpeg-static/ffmpeg",
      "./node_modules/ffmpeg-static/index.js",
      "./node_modules/ffmpeg-static/package.json",
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
