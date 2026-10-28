import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/** Tailwind classes and CSS variables with the colour names U1 retired. */
const OLD_TOKENS = String.raw`/(\b(bg|text|border|ring|fill|stroke|outline|from|to|via|decoration|divide|caret|placeholder|shadow)-(paper-raised|ink-muted|tutor|accent|error|check|sidebar|sidebar-ink|dot)\b)|var\(--(tutor|accent|error|check|dot|ink-muted|paper-raised|sidebar)\)/`;

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "no-useless-escape": "error",
      // U1 (docs/NEB_APP_UI.md §3.1): the colour names before the design tokens. Use the tokens:
      // paper-hi, muted, line, neb / neb-ink (neb only), ink (links, focus), danger (deleting).
      "no-restricted-syntax": [
        "error",
        {
          selector: `Literal[value=${OLD_TOKENS}], TemplateElement[value.raw=${OLD_TOKENS}]`,
          message:
            "Old colour name: use the design tokens (paper-hi, muted, line, neb, neb-ink, ink, danger).",
        },
      ],
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
