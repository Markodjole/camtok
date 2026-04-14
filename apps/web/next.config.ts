import type { NextConfig } from "next";
import path from "path";

/** Monorepo root (Vercel Root Directory = apps/web → `next build` cwd is apps/web). */
const outputFileTracingRoot = path.resolve(process.cwd(), "../..");

const nextConfig: NextConfig = {
  /** Lets NFT resolve workspace deps + hoisted pnpm store paths; avoids broken / oversized traces on Vercel. */
  outputFileTracingRoot,
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
