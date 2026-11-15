import { on } from "./tauri";

/**
 * Neb's hand (`screen_hand.rs`): Neb's own cursor, which goes and clicks what the student asked
 * for. Rust moves its window; this page only shows its look: moving, thinking (choosing the next
 * action), or a click (a ring that spreads from the tip, once per click).
 */
const LOOKS: readonly string[] = ["moving", "thinking", "click"];

const hand = document.getElementById("hand");

on("mew:hand-look", (detail) => {
  const look = (detail as { look?: unknown } | null)?.look;
  if (!hand || typeof look !== "string" || !LOOKS.includes(look)) return;
  if (look === "click") {
    // Start the ring again even when two clicks follow each other.
    hand.dataset.look = "moving";
    void hand.getBoundingClientRect();
  }
  hand.dataset.look = look;
});
