// Bundles Screen Coach's overlay pages (desktop/overlay-src) into the shell the app ships
// (desktop/shell/gen, gitignored). Runs before `tauri dev` and `tauri build`.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

await build({
  absWorkingDir: root,
  entryPoints: {
    "ink-overlay": "overlay-src/ink-overlay.ts",
    "ink-pill": "overlay-src/ink-pill.ts",
    "clip-preview": "overlay-src/clip-preview.ts",
    "notes-panel": "overlay-src/notes-panel.ts",
  },
  outdir: "shell/gen",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "none",
  logLevel: "info",
});
