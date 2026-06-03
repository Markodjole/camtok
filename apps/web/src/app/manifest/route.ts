import { NextResponse } from "next/server";

const manifest = {
  name: "Crosstown",
  short_name: "Crosstown",
  description: "Watch the drive. Call the next move.",
  start_url: "/live",
  display: "standalone",
  background_color: "#0d0d0d",
  theme_color: "#8249df",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
  ],
};

export function GET() {
  return NextResponse.json(manifest, {
    headers: {
      "Content-Type": "application/manifest+json",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
