// The CMediSewa mark as SVG: a pine tile, a white "C" (drawn as an arc, so it never depends on a
// font) and the marigold token dot. ONE source for the in-app launch logo and for the generated
// launch images (scripts/generate-pwa-assets.mjs), so they can't drift apart.

export const PINE = "#0f5c4d";
export const MARIGOLD = "#e9a514";
export const CANVAS = "#f5f8f7";   // the app's own background: the launch screen is the same surface
export const INK = "#15232b";

/** The mark on a `size`-px square. `rounded` false gives a full-bleed tile (maskable / iOS icons). */
export function markSvg(size = 512, rounded = true): string {
  const s = size, r = rounded ? s * 0.22 : 0;
  // the "C": an arc around the centre, open on the right, thick stroke with round ends
  const cx = s * 0.47, cy = s * 0.52, R = s * 0.25, w = s * 0.11;
  const a0 = (48 * Math.PI) / 180, a1 = (312 * Math.PI) / 180;
  const x0 = cx + R * Math.cos(a0), y0 = cy - R * Math.sin(a0), x1 = cx + R * Math.cos(a1), y1 = cy - R * Math.sin(a1);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">`
    + `<rect width="${s}" height="${s}" rx="${r}" ry="${r}" fill="${PINE}"/>`
    + `<path d="M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${R} ${R} 0 1 0 ${x1.toFixed(1)} ${y1.toFixed(1)}" fill="none" stroke="#ffffff" stroke-width="${w}" stroke-linecap="round"/>`
    + `<circle cx="${(s * 0.765).toFixed(1)}" cy="${(s * 0.255).toFixed(1)}" r="${(s * 0.07).toFixed(1)}" fill="${MARIGOLD}"/>`
    + `</svg>`;
}
