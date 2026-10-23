import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Every test file builds its own database in WebAssembly and runs all migrations in
    // beforeAll: seconds each, and several files do it at once (more under `pnpm check`).
    hookTimeout: 60_000,
  },
});
