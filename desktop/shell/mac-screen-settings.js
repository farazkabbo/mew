/* Bundled local page only. No remote requests, HTML interpolation or arbitrary native commands. */
"use strict";
const element = (id) => document.getElementById(id);
const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);
let current = null;
let updateBusy = false;
function show(status) {
  current = status.config;
  element("visible").checked = current.privacy.showInCaptures;
  element("paused").checked = current.paused;
  element("silent").checked = current.circle.silent;
  element("help").value = current.help;
  element("capture").textContent = status.captureBlocker;
  element("fields").disabled = false;
  element("tools").disabled = false;
}
function notice(message) {
  element("message").textContent = message;
}
async function updates() {
  const view = await invoke("desktop_update_status");
  const phase = view.phase;
  const label = {
    off: "Updates are off in this build.",
    idle: "Ready to check for updates.",
    checking: "Checking for updates…",
    upToDate: "You have the latest version.",
    downloading: "Downloading an update…",
    ready: "An update is ready. Restart when it suits you.",
    failed: "Couldn't check for updates. Try again later.",
  };
  element("update-status").textContent =
    `Version ${view.current}. ${label[phase.state] ?? "Update status unavailable."}`;
  element("check-update").disabled =
    updateBusy || !["idle", "upToDate", "failed"].includes(phase.state);
  element("install-update").hidden = phase.state !== "ready";
}
element("preferences").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!current) return;
  element("fields").disabled = true;
  try {
    const next = await invoke("mac_settings_update", {
      patch: {
        paused: element("paused").checked,
        privacy: { ...current.privacy, showInCaptures: element("visible").checked },
        circle: { ...current.circle, silent: element("silent").checked },
        help: element("help").value,
      },
    });
    show(next);
    notice("Preferences saved on this Mac.");
  } catch {
    notice("Couldn't finish updating preferences. Reopen settings to check what was saved.");
  } finally {
    element("fields").disabled = false;
  }
});
element("tools").addEventListener("click", async () => {
  try {
    await invoke("mac_tools_toggle");
    notice("Neb tools updated.");
  } catch {
    notice("Couldn't open Neb tools. Try again from the menu bar.");
  }
});
for (const [id, command] of [
  ["check-update", "desktop_update_check"],
  ["install-update", "desktop_update_install"],
]) {
  element(id).addEventListener("click", async () => {
    updateBusy = true;
    element(id).disabled = true;
    try {
      await invoke(command);
      await updates();
    } catch {
      notice("Couldn't update the app. Try again later.");
    } finally {
      updateBusy = false;
      element(id).disabled = false;
    }
  });
}
window.addEventListener(
  "neb:update-changed",
  () => void updates().catch(() => notice("Update status unavailable.")),
);
void invoke("mac_settings_status")
  .then((status) => {
    show(status);
    notice(
      status.settingsReset
        ? "Unusable settings were reset to safe defaults."
        : "Settings stay on this Mac.",
    );
  })
  .catch(() => notice("Couldn't load local settings."));
void updates().catch(() => {
  element("update-status").textContent = "Update status unavailable.";
});
