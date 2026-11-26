/* Bundled local page only. No remote requests, HTML interpolation or arbitrary native commands. */
"use strict";
const element = (id) => document.getElementById(id);
const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);
let current = null;
let updateBusy = false;
function show(status) {
  current = status.config;
  element("voice-shortcut-status").textContent =
    status.voiceShortcutAvailable === false
      ? "The voice shortcut is unavailable. Use the microphone on Neb tools."
      : "Voice: hold Control + Shift + Space, then release to ask.";
  element("enabled").checked = current.enabled;
  element("blocked").value = current.privacy.blockedApps
    .map((name) => name.replace(/\.exe$/, ""))
    .join("\n");
  element("scope").value = current.privacy.askScope;
  element("save-mode").value = current.circle.save;
  element("redact-emails").checked = current.privacy.redaction.emails;
  element("redact-phones").checked = current.privacy.redaction.phones;
  element("click").checked = current.privacy.letNebClick;
  element("calls").checked = current.privacy.pauseDuringCalls;
  element("visible").checked = current.privacy.showInCaptures;
  element("paused").checked = current.paused;
  element("silent").checked = current.circle.silent;
  element("help").value = current.help;
  element("handoff").checked = current.handoff.timeline;
  element("sender").value = current.handoff.senderName;
  element("cursor-debug").checked = current.cursor.debug;
  element("cursor-traces").checked = current.cursor.recordTraces;
  element("cursor-counts").textContent = JSON.stringify(status.cursorCounts ?? {});
  element("catch").checked = current.cursor.catchMe;
  element("guidance").value = current.cursor.guidance;
  element("cue-voice").checked = current.cursor.voice;
  element("capture").textContent = status.captureBlocker;
  element("tools").title =
    status.toolsShortcutAvailable === false
      ? "Tools shortcut unavailable; use this button"
      : "Control + Shift + I shows or hides Neb tools";
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
        enabled: element("enabled").checked,
        consentVersion: element("enabled").checked ? 5 : 0,
        paused: element("paused").checked,
        privacy: {
          ...current.privacy,
          showInCaptures: element("visible").checked,
          pauseDuringCalls: element("calls").checked,
          letNebClick: element("click").checked,
          askScope: element("scope").value,
          blockedApps: element("blocked")
            .value.split("\n")
            .map((name) => name.trim())
            .filter(Boolean),
          redaction: {
            ...current.privacy.redaction,
            emails: element("redact-emails").checked,
            phones: element("redact-phones").checked,
          },
        },
        circle: {
          ...current.circle,
          silent: element("silent").checked,
          save: element("save-mode").value,
        },
        help: element("help").value,
        handoff: {
          ...current.handoff,
          timeline: element("handoff").checked,
          senderName: element("sender").value,
        },
        cursor: {
          ...current.cursor,
          debug: element("cursor-debug").checked,
          recordTraces: element("cursor-traces").checked,
          catchMe: element("catch").checked,
          catchMeConsent: element("catch").checked ? 1 : 0,
          guidance: element("guidance").value,
          voice: element("cue-voice").checked,
        },
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

element("handoff-start").addEventListener("click", async () => {
  try {
    await invoke("mac_handoff_start");
  } catch {
    notice("Enable Screen Coach and the Handoff timeline, then try again.");
  }
});

element("forget-paths").addEventListener("click", async () => {
  try {
    await invoke("screen_coach_forget_paths");
    notice("Learned paths deleted for this account.");
  } catch {
    notice("Couldn't delete learned paths. Try again.");
  }
});
