"use strict";
window.addEventListener("mew:mac-catch", ({ detail }) => {
  if (detail && typeof detail.message === "string")
    document.getElementById("message").textContent = detail.message.slice(0, 300);
});
for (const button of document.querySelectorAll("button[data-action]"))
  button.addEventListener("click", () => {
    window.__TAURI_INTERNALS__
      .invoke("mac_cursor_catch_action", { action: button.dataset.action })
      .catch(() => {});
  });
