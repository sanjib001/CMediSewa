import type { Metadata, Viewport } from "next";
import { Mukta } from "next/font/google";
import "./globals.css";
import { PwaRegister } from "@/components/pwa/pwa-register";
import { KeyboardNav } from "@/components/ui/keyboard-nav";
import { LaunchScreen } from "@/components/pwa/launch-screen";
import { APPLE_SPLASH } from "@/lib/pwa/apple-splash";

// Mukta: one family designed for Devanagari and Latin together, so Nepali names, BS dates
// and English UI share a baseline and a voice (ui-ux.md §12).
const mukta = Mukta({
  subsets: ["latin", "devanagari"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-mukta",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "CMediSewa", template: "%s · CMediSewa" },
  description: "Clinic and pharmacy management for Nepal: registration, OPD, pharmacy, stock and finance.",
  applicationName: "CMediSewa",
  // iPhone / iPad home-screen app (U8): opens full screen with the clinic's colours.
  // startupImage: the logo on launch, one image per iPhone / iPad screen (scripts/generate-pwa-assets.mjs, D-161).
  appleWebApp: { capable: true, title: "CMediSewa", statusBarStyle: "default", startupImage: APPLE_SPLASH },
  icons: { icon: [{ url: "/pwa-icon/192", sizes: "192x192", type: "image/png" }], apple: [{ url: "/pwa-icon/180", sizes: "180x180", type: "image/png" }] },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: "#0f5c4d",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={mukta.variable} suppressHydrationWarning>
      <body className="min-h-dvh antialiased"><LaunchScreen />{children}<PwaRegister /><KeyboardNav /></body>
    </html>
  );
}
