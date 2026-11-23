import type { Metadata } from "next";
import { Providers } from "./providers";
import { ServiceWorkerRegistration } from "@/components/ServiceWorkerRegistration";
import { PressIn } from "@/components/kitchen/PressIn";
import { AmbientLight } from "@/lib/ambient/AmbientLight";
import { ambientHeadScript } from "@/lib/ambient/head-script";
import { getAmbientForce, getKitchenPlace } from "@/lib/ambient/location";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sous",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Sous",
  },
  icons: {
    icon: "/icon-192.png",
    apple: "/apple-touch-icon.png",
  },
};

export const viewport = {
  themeColor: "#F6F4EE", // the ground, Natural Stoneware (tokens.css --ground-day; DS §1 v1.24)
  interactiveWidget: "resizes-content" as const,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // The head script sets style on <html> before React hydrates it.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* P67: --ambient-t before the first paint, from the same engine as
            AmbientLight, so a cold load at night paints night with no fade. */}
        <script dangerouslySetInnerHTML={{ __html: ambientHeadScript(getKitchenPlace(), getAmbientForce()) }} />
      </head>
      <body className="antialiased font-sans">
        <AmbientLight />
        <PressIn />
        <ServiceWorkerRegistration />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
