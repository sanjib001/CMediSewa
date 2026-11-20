import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-hosted on Coolify as a container (deployment.md §8).
  output: "standalone",
  // `pg` is used server-side by the realtime LISTEN bus (B9) and must not be bundled
  // (HRestroSewa lesson: bundling breaks its dynamic requires silently).
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
  async headers() {
    return [
      {
        // Baseline hardening for every page on the single host (D-59). The full nonce-based
        // CSP is added with the first real pages in Phase 1 (security.md §8).
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
