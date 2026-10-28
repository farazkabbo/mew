import localFont from "next/font/local";

/**
 * The four families (docs/NEB_APP_UI.md §3.2), from the vendored files in packages/shared/fonts
 * (decision U8: offline, no font service). Each sets the CSS variable the tokens' stacks use.
 */
export const inter = localFont({
  variable: "--font-inter",
  display: "swap",
  src: [
    { path: "../../../packages/shared/fonts/inter-latin-400-normal.woff2", weight: "400" },
    { path: "../../../packages/shared/fonts/inter-latin-500-normal.woff2", weight: "500" },
    { path: "../../../packages/shared/fonts/inter-latin-600-normal.woff2", weight: "600" },
  ],
});

export const instrumentSerif = localFont({
  variable: "--font-instrument-serif",
  display: "swap",
  src: "../../../packages/shared/fonts/instrument-serif-latin-400-normal.woff2",
  weight: "400",
});

export const pixelify = localFont({
  variable: "--font-pixelify",
  display: "swap",
  src: "../../../packages/shared/fonts/pixelify-sans-latin-500-normal.woff2",
  weight: "500",
  // neb's words are short; don't hold up the first paint for them.
  preload: false,
});

export const caveat = localFont({
  variable: "--font-caveat",
  display: "swap",
  src: "../../../packages/shared/fonts/caveat-latin-500-normal.woff2",
  weight: "500",
  preload: false,
});

export const fontVariables = [inter, instrumentSerif, pixelify, caveat]
  .map((f) => f.variable)
  .join(" ");
