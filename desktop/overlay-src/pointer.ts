import { on } from "./tauri";

/**
 * The tutor pointer (Circle & Ask, S3.2 §2.1): a small Mew mark beside the cursor. Rust moves
 * its window; this page only shows its look: idle (faint), drawing (a pen tip, whenever input is
 * being taken: §7.3), listening, thinking, explaining, or blocked (this app can't be looked at).
 */
const LOOKS: readonly string[] = [
  "idle",
  "drawing",
  "listening",
  "thinking",
  "explaining",
  "blocked",
];

const pointer = document.getElementById("pointer");

on("mew:pointer-look", (detail) => {
  const look = (detail as { look?: unknown } | null)?.look;
  if (pointer && typeof look === "string" && LOOKS.includes(look)) {
    pointer.dataset.look = look;
  }
});
