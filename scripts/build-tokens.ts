/**
 * Writes the design tokens (packages/shared/src/ui/tokens.ts) as CSS for the web app and the
 * desktop overlays: `pnpm build:tokens`. A frontend test fails when either file is stale.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";

import { tokensCss } from "../packages/shared/src/ui/tokens";

const root = path.resolve(import.meta.dirname, "..");
export const TOKEN_FILES = ["frontend/src/app/tokens.css", "desktop/shell/tokens.css"];

for (const file of TOKEN_FILES) {
  writeFileSync(path.join(root, file), tokensCss());
  console.log(`wrote ${file}`);
}
