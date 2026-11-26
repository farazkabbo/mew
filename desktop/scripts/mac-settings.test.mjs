import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import assert from "node:assert/strict";
const html = readFileSync(new URL("../shell/mac-screen-settings.html", import.meta.url), "utf8");
const code = readFileSync(new URL("../shell/mac-screen-settings.js", import.meta.url), "utf8");
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture() {
  const elements = new Map(
    [...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [
      id,
      {
        listeners: {},
        addEventListener(name, fn) {
          this.listeners[name] = fn;
        },
      },
    ]),
  );
  const config = {
    cursor: { catchMe: false, catchMeConsent: 0, guidance: "auto", voice: true },
    handoff: { timeline: false, senderName: "" },
    enabled: false,
    paused: false,
    privacy: {
      showInCaptures: false,
      pauseDuringCalls: true,
      letNebClick: false,
      askScope: "window",
      blockedApps: ["outlook.exe"],
      redaction: { cards: true, secrets: true, codes: true, emails: false, phones: false },
    },
    circle: { silent: false, save: "auto" },
    help: "hint",
  };
  const calls = [];
  const invoke = async (command, args) => {
    calls.push([command, args]);
    if (command === "desktop_update_status") return { current: "0.1.7", phase: { state: "off" } };
    return { config, captureBlocker: "fixture", settingsReset: false };
  };
  runInNewContext(code, {
    document: { getElementById: (id) => elements.get(id) ?? null },
    window: { __TAURI__: { core: { invoke } }, addEventListener() {} },
    console,
  });
  return { elements, calls, config };
}
test("bundled settings initializes every actual HTML control", async () => {
  const { elements } = fixture();
  await tick();
  assert.equal(elements.get("message").textContent, "Settings stay on this Mac.");
  assert.equal(elements.get("fields").disabled, false);
  assert.equal(elements.get("enabled").checked, false);
  assert.equal(elements.get("blocked").value, "outlook");
});
test("explicit save submits consent and privacy choices through native IPC", async () => {
  const { elements, calls } = fixture();
  await tick();
  elements.get("enabled").checked = true;
  elements.get("visible").checked = true;
  elements.get("scope").value = "monitor";
  elements.get("redact-emails").checked = true;
  elements.get("save-mode").value = "ask";
  elements.get("blocked").value = "com.apple.Mail\ncom.example.editor\n";
  await elements.get("preferences").listeners.submit({ preventDefault() {} });
  const patch = calls.find(([command]) => command === "mac_settings_update")[1].patch;
  assert.equal(patch.enabled, true);
  assert.equal(patch.consentVersion, 5);
  assert.equal(patch.privacy.askScope, "monitor");
  assert.equal(patch.privacy.redaction.emails, true);
  assert.equal(patch.privacy.redaction.secrets, true);
  assert.equal(patch.circle.save, "ask");
  assert.equal(
    Array.from(patch.privacy.blockedApps).join(","),
    "com.apple.Mail,com.example.editor",
  );
});
