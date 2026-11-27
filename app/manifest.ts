import type { MetadataRoute } from "next";

// Web app manifest (U8): staff install CMediSewa on the desk computer, tablet or phone and it
// opens like an app, straight into their workspace. No data is cached for offline use.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "CMediSewa",
    short_name: "CMediSewa",
    description: "Clinic and pharmacy: registration, OPD, pharmacy, stock and finance.",
    id: "/employee",
    start_url: "/employee",
    scope: "/",
    display: "standalone",
    orientation: "any",
    // Android builds its launch screen from this colour and the icon: the app's own background,
    // so the launch screen and the first page are one surface (D-161).
    background_color: "#f5f8f7",
    theme_color: "#0f5c4d",
    categories: ["medical", "business"],
    icons: [
      { src: "/pwa-icon/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/pwa-icon/512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/pwa-icon/maskable-512", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
