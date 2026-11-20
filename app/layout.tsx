import type { Metadata, Viewport } from "next";
import { Mukta } from "next/font/google";
import "./globals.css";

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
};

export const viewport: Viewport = {
  themeColor: "#0f5c4d",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={mukta.variable}>
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
