import { existsSync } from "node:fs";
import path from "node:path";

import type { NextConfig } from "next";

const repoRoot = path.resolve(import.meta.dirname, "../..");

// Local development reads the repo-root .env.local shared with services/api.
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
  poweredByHeader: false,
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
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
