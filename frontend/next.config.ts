import { existsSync } from "node:fs";
import path from "node:path";

import type { NextConfig } from "next";

const repoRoot = path.resolve(import.meta.dirname, "..");

// Local development reads the repo-root .env.local shared with the backend.
// Variables already present in the environment (e.g. set by the host) take precedence.
const rootEnvFile = path.join(repoRoot, ".env.local");
if (existsSync(rootEnvFile)) process.loadEnvFile(rootEnvFile);

// The Content-Security-Policy itself is set per request (with a nonce) in src/proxy.ts.
const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  {
    key: "Permissions-Policy",
    value: "microphone=(self), camera=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
  },
];

const nextConfig: NextConfig = {
  // A separate build folder lets the e2e server run beside a normal `next dev` (one per folder).
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  poweredByHeader: false,
  devIndicators: false,
  reactStrictMode: true,
  transpilePackages: ["@mew/shared", "@mew/ink"],
  turbopack: {
    root: repoRoot,
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // The code checker's worker runs students' Python in WebAssembly: it may compile wasm and
      // fetch its own runtime files, nothing else. (A worker's CSP comes from its own response.)
      ...["/workers/:path*", "/pyodide/:path*"].map((source) => ({
        source,
        headers: [
          {
            key: "Content-Security-Policy",
            value:
              "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; " +
              "frame-ancestors 'none'",
          },
        ],
      })),
    ];
  },
};

export default nextConfig;
