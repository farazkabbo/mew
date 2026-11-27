/* Bundled local page only. No remote requests, HTML interpolation or arbitrary native commands. */
"use strict";
const element = (id) => document.getElementById(id);
const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);
let current = null;
let updateBusy = false;
let defaultPrivacy = null;
const catchRules = ["reply_all", "attachment", "unsaved", "delete", "terminal"];
function show(status) {
  current = status.config;
  element("account-state").textContent =
    status.accountConnected === true
      ? "Screen Coach has a connected native account."
      : status.accountConnected === false
        ? "Screen Coach is not connected. Open your notebook to sign in."
        : "Account status has not been checked in this session. Open your notebook to check.";
  defaultPrivacy = status.defaultPrivacy ?? defaultPrivacy;
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
  element("pointer-show").value = current.circle.pointer ?? "always";
  element("pointer-size").value = current.circle.pointerSize ?? "medium";
  element("pointer-corner").value = current.circle.pointerCorner ?? "bottom_right";
  element("include-link").checked = current.circle.includeSourceLink ?? true;
  for (const rule of catchRules)
    element(`catch-rule-${rule}`).checked = !(current.cursor.rulesOff ?? []).includes(rule);
  element("catch-state").textContent = status.catchPaused
    ? "CATCH ME is temporarily paused from the menu bar."
    : "CATCH ME follows the consent and rules selected here.";
  element("catch-snoozed").textContent = Object.entries(current.cursor.snoozed ?? {})
    .filter(([, until]) => until > Date.now() / 1000)
    .map(([rule, until]) => `${rule}: snoozed until ${new Date(until * 1000).toLocaleTimeString()}`)
    .join(" · ");
  element("handoff-window").value = String(current.handoff.windowMin ?? 90);
  element("handoff-expiry").value = String(current.handoff.expiryDays ?? 7);
  element("handoff-names").checked = current.handoff.alwaysHideNames ?? false;
  element("handoff-timeline-state").textContent =
    `${status.handoffTimeline?.count ?? 0} local timeline records. ${(status.handoffTimeline?.recent ?? []).map((event) => `${event.kind} ${event.at}`).join(" · ")}`;
  element("handoff-recipients").textContent = (current.handoff.recent ?? []).length
    ? `Recent recipients: ${current.handoff.recent.join(", ")}`
    : "No recent recipients.";
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
  element("cursor-counts").textContent = status.cursorCounts
    ? JSON.stringify(status.cursorCounts)
    : "Refresh local history to inspect cursor counts.";
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
          pointer: element("pointer-show").value,
          pointerSize: element("pointer-size").value,
          pointerCorner: element("pointer-corner").value,
          includeSourceLink: element("include-link").checked,
          silent: element("silent").checked,
          save: element("save-mode").value,
        },
        help: element("help").value,
        handoff: {
          ...current.handoff,
          timeline: element("handoff").checked,
          windowMin: Number(element("handoff-window").value),
          expiryDays: Number(element("handoff-expiry").value),
          alwaysHideNames: element("handoff-names").checked,
          senderName: element("sender").value,
        },
        cursor: {
          ...current.cursor,
          rulesOff: catchRules.filter((rule) => !element(`catch-rule-${rule}`).checked),
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

async function localEdit(patch) {
  try {
    show(await invoke("mac_settings_update", { patch }));
    notice("Preferences saved on this Mac.");
  } catch {
    notice("Couldn't save this change. Reopen settings to check it.");
  }
}
element("restore-blocklist").addEventListener("click", () => {
  if (defaultPrivacy)
    element("blocked").value = defaultPrivacy.blockedApps
      .map((name) => name.replace(/\.exe$/, ""))
      .join("\n");
  notice("Default blocked apps restored in the form. Save preferences to apply.");
});
element("catch-reset").addEventListener(
  "click",
  () => current && localEdit({ cursor: { ...current.cursor, snoozed: {}, notMistakes: {} } }),
);
element("handoff-clear-recipients").addEventListener(
  "click",
  () => current && localEdit({ handoff: { ...current.handoff, recent: [] } }),
);
element("handoff-forget").addEventListener("click", async () => {
  try {
    show(await invoke("mac_handoff_forget"));
    notice("Local Handoff timeline deleted.");
  } catch {
    notice("Couldn't delete the timeline. Try again.");
  }
});
element("open-mic-settings").addEventListener("click", async () => {
  try {
    await invoke("mac_open_microphone_settings");
  } catch {
    notice("Open System Settings → Privacy & Security → Microphone to allow Neb.");
  }
});

element("open-notebook").addEventListener("click", async () => {
  try {
    await invoke("mac_open_notebook");
  } catch {
    notice("Couldn't open the notebook. Use Open Neb in the menu bar.");
  }
});

element("local-history").addEventListener("click", async () => {
  try {
    show(await invoke("mac_local_history"));
  } catch {
    notice("Couldn't inspect local history. Check your notebook account and try again.");
  }
});
