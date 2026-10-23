import { invoke, on } from "./tauri";

/**
 * The ink pill (S3, decision 9): Save to notebook · Clear, next to the tutor's ink. Its window
 * never takes focus, so the student's app stays active; keyboard users have Ctrl+Alt+C and Esc,
 * which the pill shows.
 */
const buttons = document.querySelectorAll<HTMLButtonElement>("button[data-action]");

for (const button of buttons) {
  button.addEventListener("click", () => {
    const action = button.dataset.action;
    if (action !== "save" && action !== "clear") return;
    for (const b of buttons) b.disabled = true;
    void invoke("screen_ink_pill", { action }).catch(() => undefined);
  });
}

on("mew:pill-show", () => {
  for (const b of buttons) b.disabled = false;
});
