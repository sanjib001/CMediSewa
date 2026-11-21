import { ImageResponse } from "next/og";

// App icons for the web app manifest (U8), drawn in code so there are no image assets to keep
// in sync: pine square, a white "C" with a marigold token dot. /pwa-icon/192, /pwa-icon/512, and
// /pwa-icon/maskable-512 (extra padding so Android's mask never clips the mark).
export const dynamic = "force-static";
const SIZES = ["192", "512", "maskable-512", "180"] as const;
export function generateStaticParams() { return SIZES.map((size) => ({ size })); }

export async function GET(_req: Request, { params }: { params: Promise<{ size: string }> }) {
  const { size } = await params;
  if (!SIZES.includes(size as (typeof SIZES)[number])) return new Response("Not found", { status: 404 });
  const maskable = size.startsWith("maskable");
  const px = Number(size.replace("maskable-", ""));
  const mark = Math.round(px * (maskable ? 0.5 : 0.62));
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#0f5c4d", borderRadius: maskable || px === 180 ? 0 : Math.round(px * 0.2) }}>
        <div style={{ position: "relative", width: mark, height: mark, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ color: "#ffffff", fontSize: Math.round(mark * 0.95), fontWeight: 700, lineHeight: 1, fontFamily: "sans-serif" }}>C</div>
          <div style={{ position: "absolute", right: Math.round(mark * 0.02), top: Math.round(mark * 0.1), width: Math.round(mark * 0.22), height: Math.round(mark * 0.22), borderRadius: 9999, background: "#f2a93b" }} />
        </div>
      </div>
    ),
    { width: px, height: px },
  );
}
