import type { Metadata, Viewport } from "next";
import { Exo_2 } from "next/font/google";
import { Providers } from "@/components/providers";
import "./globals.css";

const exo2 = Exo_2({
  subsets: ["latin"],
  display: "swap",
  preload: false,
  variable: "--font-exo2",
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Crosstown — Watch the drive. Call the next move.",
  description:
    "Live dashcam prediction game. Watch real city drives, bet on the next turn, zone, and route.",
  manifest: "/manifest.json",
  icons: {
    icon: "/crosstown-logo.png",
    apple: "/icon-192.png",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Crosstown",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  interactiveWidget: "resizes-content",
  viewportFit: "cover",
  themeColor: "#0d0d0d",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`dark ${exo2.variable}`} data-scroll-behavior="smooth">
      <body className={`${exo2.className} font-sans`}>
        <div id="app-root">
          <Providers>{children}</Providers>
        </div>
      </body>
    </html>
  );
}
