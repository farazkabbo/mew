import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import assert from "node:assert/strict";
const html = readFileSync(new URL("../shell/mac-screen-settings.html", import.meta.url), "utf8");
const code = readFileSync(new URL("../shell/mac-screen-settings.js", import.meta.url), "utf8");
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(companion = { pending: [], connections: [], pairings: [] }) {
  function node() {
    return {
      listeners: {},
      children: [],
      addEventListener(name, fn) {
        this.listeners[name] = fn;
      },
      append(...children) {
        this.children.push(...children);
      },
      replaceChildren() {
        this.children = [];
      },
    };
  }
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, node()]));
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
    if (command === "mac_browser_companion") return companion;
    if (command === "desktop_update_status") return { current: "0.1.7", phase: { state: "off" } };
    return { config, captureBlocker: "fixture", settingsReset: false };
  };
  runInNewContext(code, {
    document: { getElementById: (id) => elements.get(id) ?? null, createElement: () => node() },
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
test("pointer, source, Catch rules and Handoff choices are native settings", async () => {
  const { elements, calls } = fixture();
  await tick();
  assert.ok(elements.has("pointer-show"));
  elements.get("pointer-show").value = "never";
  elements.get("pointer-size").value = "large";
  elements.get("pointer-corner").value = "top_left";
  elements.get("include-link").checked = false;
  elements.get("catch-rule-attachment").checked = false;
  elements.get("handoff-window").value = "180";
  elements.get("handoff-expiry").value = "30";
  elements.get("handoff-names").checked = true;
  await elements.get("preferences").listeners.submit({ preventDefault() {} });
  const patch = calls.find(([command]) => command === "mac_settings_update")[1].patch;
  assert.equal(patch.circle.pointer, "never");
  assert.equal(patch.circle.pointerSize, "large");
  assert.equal(patch.circle.pointerCorner, "top_left");
  assert.equal(patch.circle.includeSourceLink, false);
  assert.deepEqual(Array.from(patch.cursor.rulesOff), ["attachment"]);
  assert.equal(patch.handoff.windowMin, 180);
  assert.equal(patch.handoff.expiryDays, 30);
  assert.equal(patch.handoff.alwaysHideNames, true);
});
test("timeline deletion and microphone settings use narrow native commands", async () => {
  const { elements, calls } = fixture();
  await tick();
  await elements.get("handoff-forget").listeners.click();
  await elements.get("open-mic-settings").listeners.click();
  assert.ok(calls.some(([command]) => command === "mac_handoff_forget"));
  assert.ok(calls.some(([command]) => command === "mac_open_microphone_settings"));
});
test("account help opens the scoped notebook without accepting credentials", async () => {
  const { elements, calls } = fixture();
  await tick();
  assert.ok(elements.has("account-state"));
  await elements.get("open-notebook").listeners.click();
  const call = calls.find(([command]) => command === "mac_open_notebook");
  assert.ok(call);
  assert.equal(call[1], undefined);
});

test("browser pairing shows signed publisher as text and sends only the selected identity", async () => {
  const pending = {
    connectionId: "1".repeat(32),
    profileId: "2".repeat(32),
    browserIdentifier: "org.mozilla.firefox",
    signer: "<img src=x onerror=alert(1)>",
    team: "TESTTEAM",
  };
  const pairing = {
    pairingId: "3".repeat(32),
    profileId: "4".repeat(32),
    browserIdentifier: "com.google.Chrome",
  };
  const { elements, calls } = fixture({
    pending: [pending],
    pairings: [pairing],
    connections: [{ trusted: true }],
  });
  await tick();
  await elements.get("browser-refresh").listeners.click();
  const rows = elements.get("browser-profiles").children;
  assert.equal(rows.length, 2);
  assert.ok(rows[0].children[0].textContent.includes(pending.signer));
  assert.equal(rows[0].children[0].innerHTML, undefined);
  await rows[0].children[1].listeners.click();
  await elements.get("browser-profiles").children[1].children[1].listeners.click();
  const actions = calls
    .filter(([command]) => command === "mac_browser_companion")
    .map(([, args]) => args.action);
  assert.equal(actions[1].action, "approve");
  assert.equal(actions[1].id, pending.connectionId);
  assert.equal(actions[2].action, "revoke");
  assert.equal(actions[2].id, pairing.pairingId);
  assert.match(elements.get("browser-state").textContent, /1 connected profiles/);
});
