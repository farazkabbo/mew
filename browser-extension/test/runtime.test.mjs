import test from "node:test";
import assert from "node:assert/strict";
import { installBackground } from "../src/runtime.js";
function event() {
  const listeners = [];
  return {
    addListener: (f) => listeners.push(f),
    emit: (...args) => listeners.forEach((f) => f(...args)),
    listeners,
  };
}
function fixture(saved = {}) {
  const ports = [],
    timers = [];
  const message = event();
  const local = { ...saved };
  const api = {
    storage: {
      local: { get: async () => ({ ...local }), set: async (patch) => Object.assign(local, patch) },
    },
    runtime: {
      id: "extension",
      getURL: (p) => `chrome-extension://extension/${p}`,
      onMessage: message,
      connectNative: (name) => {
        assert.equal(name, "com.neb.browser_companion");
        const port = {
          onMessage: event(),
          onDisconnect: event(),
          sent: [],
          postMessage: (m) => port.sent.push(m),
          disconnect: () => port.onDisconnect.emit(),
        };
        ports.push(port);
        return port;
      },
    },
    webNavigation: {
      onBeforeNavigate: event(),
      onCommitted: event(),
      onHistoryStateUpdated: event(),
      onReferenceFragmentUpdated: event(),
    },
    tabs: { onUpdated: event(), onRemoved: event(), onActivated: event() },
    windows: { onFocusChanged: event() },
    permissions: { onRemoved: event() },
  };
  const background = installBackground(api, {
    schedule: (f) => (timers.push(f), timers.length),
    cancelSchedule: () => {},
  });
  const popup = { id: "extension", url: api.runtime.getURL("popup.html") };
  const send = (body, sender = popup) =>
    new Promise((resolve) => {
      const accepted = message.listeners[0](body, sender, resolve);
      if (accepted !== true) resolve(undefined);
    });
  return { background, ports, timers, send, api, local };
}
test("new profile never connects or pairs before exact toolbar popup request", async () => {
  const f = fixture();
  await f.background.ready;
  assert.equal(f.ports.length, 0);
  assert.equal(
    await f.send({ type: "pair" }, { id: "extension", url: "https://example.com", tab: { id: 1 } }),
    undefined,
  );
  assert.equal(
    await f.send({ type: "pair" }, { id: "other", url: "chrome-extension://extension/popup.html" }),
    undefined,
  );
  assert.equal(f.ports.length, 0);
  const result = await f.send({ type: "pair" });
  assert.equal(result.ok, true);
  assert.equal(f.ports[0].sent[0].type, "pair");
  assert.equal(f.ports[0].sent[0].profileId.length, 32);
});
test("reconnect says hello and never repeats pairing gesture", async () => {
  const f = fixture({ profileId: "a".repeat(32), pairRequested: true });
  await f.background.ready;
  await new Promise(setImmediate);
  assert.equal(f.ports[0].sent[0].type, "hello");
  f.ports[0].disconnect();
  assert.equal(f.timers.length, 1);
  await f.timers[0]();
  await new Promise(setImmediate);
  assert.equal(f.ports[1].sent[0].type, "hello");
});
test("disconnect revokes queued browser actions and persisted automatic reconnect choice", async () => {
  const f = fixture();
  await f.background.ready;
  await f.send({ type: "pair" });
  assert.equal(f.local.pairRequested, true);
  await f.send({ type: "unpair" });
  assert.equal(f.local.pairRequested, false);
  assert.equal((await f.send({ type: "status" })).connected, false);
});
test("a disconnected deferred request cannot block the next native connection", async () => {
  const f = fixture({ profileId: "a".repeat(32), pairRequested: true });
  await f.background.ready;
  await new Promise(setImmediate);
  let resolve;
  let first = true;
  const window = {
    id: 7,
    type: "normal",
    focused: true,
    incognito: false,
    left: 0,
    top: 0,
    width: 1000,
    height: 800,
    tabs: [{ id: 9, active: true, url: "https://example.com/", title: "Media" }],
  };
  f.api.windows.getLastFocused = async () => {
    if (first) {
      first = false;
      return new Promise((r) => (resolve = r));
    }
    return structuredClone(window);
  };
  f.api.windows.get = async () => structuredClone(window);
  f.api.webNavigation.getFrame = async () => ({
    parentFrameId: -1,
    url: "https://example.com/",
    documentId: "one",
    errorOccurred: false,
  });
  const request = {
    type: "request",
    version: 1,
    nonce: "b".repeat(32),
    profileId: "a".repeat(32),
    generation: 1,
    sequence: 1,
    operation: "probe",
  };
  const old = f.ports[0];
  old.onMessage.emit(request);
  await new Promise(setImmediate);
  old.disconnect();
  await f.timers[0]();
  await new Promise(setImmediate);
  const replacement = f.ports[1];
  replacement.onMessage.emit({ ...request, nonce: "c".repeat(32) });
  for (let n = 0; n < 100 && replacement.sent.at(-1)?.type !== "response"; n++)
    await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(replacement.sent.at(-1).status, "ok");
  resolve(window);
  await new Promise(setImmediate);
  assert.equal(old.sent.length, 1);
});
