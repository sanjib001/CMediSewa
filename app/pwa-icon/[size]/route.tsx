import sharp from "sharp";
import { markSvg, PINE } from "@/lib/pwa/mark";

// App icons for the web app manifest (U8), drawn from the ONE mark (lib/pwa/mark.ts) that the
// launch screens use too. Built once (force-static). /pwa-icon/192 and /512: the rounded tile as
// is. /pwa-icon/maskable-512: pine to the edge with the mark inside Android's safe circle, so the
// platform crop only ever eats pine. /pwa-icon/180: full-bleed for iOS, which masks its own
// corners and doesn't honour transparency.
export const dynamic = "force-static";
const SIZES = ["192", "512", "maskable-512", "180"] as const;
export function generateStaticParams() { return SIZES.map((size) => ({ size })); }

export async function GET(_req: Request, { params }: { params: Promise<{ size: string }> }) {
  const { size } = await params;
  if (!SIZES.includes(size as (typeof SIZES)[number])) return new Response("Not found", { status: 404 });
  const maskable = size.startsWith("maskable");
  const px = Number(size.replace("maskable-", ""));
  let png: Buffer;
  if (maskable) {
    const inner = Math.round(px * 0.72);
    png = await sharp({ create: { width: px, height: px, channels: 4, background: PINE } })
      .composite([{ input: Buffer.from(markSvg(inner, false)), gravity: "centre" }]).png().toBuffer();
  } else {
    png = await sharp(Buffer.from(markSvg(px, px !== 180))).png().toBuffer();
  }
  return new Response(new Uint8Array(png), { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" } });
}
