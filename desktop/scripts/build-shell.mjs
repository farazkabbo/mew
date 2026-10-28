// Bundles Screen Coach's overlay pages (desktop/overlay-src) into the shell the app ships
// (desktop/shell/gen, gitignored). Runs before `tauri dev` and `tauri build`.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

await build({
  absWorkingDir: root,
  entryPoints: {
    "ink-overlay": "overlay-src/ink-overlay.ts",
    "ink-pill": "overlay-src/ink-pill.ts",
    "clip-preview": "overlay-src/clip-preview.ts",
    "notes-panel": "overlay-src/notes-panel.ts",
    "coach-pill": "overlay-src/coach-pill.ts",
    pointer: "overlay-src/pointer.ts",
    "draw-overlay": "overlay-src/draw-overlay.ts",
    "circle-card": "overlay-src/circle-card.ts",
    "quiz-card": "overlay-src/quiz-card.ts",
    island: "overlay-src/island.ts",
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

// The app's bundled fonts (packages/shared/fonts, NEB_APP_UI §3.2) for the pages' fonts.css.
const fonts = fileURLToPath(new URL("../packages/shared/fonts/", new URL("..", import.meta.url)));
mkdirSync(`${root}shell/gen/fonts`, { recursive: true });
for (const file of readdirSync(fonts).filter((f) => f.endsWith(".woff2"))) {
  copyFileSync(`${fonts}${file}`, `${root}shell/gen/fonts/${file}`);
}
