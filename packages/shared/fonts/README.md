# Bundled fonts

The app's four type families (docs/NEB_APP_UI.md §3.2, decision U8), vendored so the desktop app
and the PWA work offline. Latin subsets from the Fontsource 5.3.0 packages; each family's SIL Open
Font License 1.1 is beside it (`OFL-*.txt`).

| File                                      | Family           | Use                                                 |
| ----------------------------------------- | ---------------- | --------------------------------------------------- |
| `inter-latin-{400,500,600}-normal.woff2`  | Inter            | UI text                                             |
| `instrument-serif-latin-400-normal.woff2` | Instrument Serif | titles and questions                                |
| `pixelify-sans-latin-500-normal.woff2`    | Pixelify Sans    | neb's voice                                         |
| `caveat-latin-500-normal.woff2`           | Caveat           | mock ink and export labels (one weight: the budget) |

Loaded by `next/font/local` in `frontend/src/app/fonts.ts` and by `@font-face` in
`desktop/shell/fonts.css`. All of them together stay under 180 KB (a test checks).
