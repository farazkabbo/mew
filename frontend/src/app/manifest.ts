import type { MetadataRoute } from "next";

/** Installable web app (PWA): Edge and Chrome can install Mew as its own window. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Neb",
    short_name: "Neb",
    description: "A quiet tutor that lives in your notebook.",
    start_url: "/notebook",
    scope: "/",
    display: "standalone",
    background_color: "#f7f5f0",
    theme_color: "#f7f5f0",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
