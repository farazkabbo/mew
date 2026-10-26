import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "server-only": path.resolve(import.meta.dirname, "test/stubs/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Route tests re-import each route's module graph after `vi.resetModules()`; with every
    // workspace's tests running at once (`pnpm check`) that alone can pass the default 5 s.
    testTimeout: 20_000,
  },
});
