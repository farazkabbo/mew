import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "no-useless-escape": "error",
    },
  },
  // public/pyodide and public/workers/vendor: vendored runtimes copied from node_modules (not our
  // code); public/workers/models: a trained model.
  globalIgnores([
    ".next/**",
    ".next-e2e/**",
    ".next-build/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "public/pyodide/**",
    "public/workers/vendor/**",
    "public/workers/models/**",
  ]),
]);
