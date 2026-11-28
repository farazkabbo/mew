import test from "node:test";
import assert from "node:assert/strict";
import { createBridge } from "../src/bridge.js";
const id = "a".repeat(32);
let requestCounter = 0;
const request = (operation = "probe", extra = {}) => ({
  type: "request",
  version: 1,
  profileId: id,
  sequence: requestCounter + 1,
  nonce: (++requestCounter).toString(16).padStart(32, "0"),
  generation: 1,
  operation,
  ...extra,
});
function fixture() {
  let window = {
    id: 7,
    type: "normal",
    focused: true,
    incognito: false,
    left: -1200,
    top: 0,
    width: 1000,
    height: 800,
    tabs: [{ id: 9, active: true, url: "https://example.com/watch", title: "Lecture" }],
  };
  let allowed = true,
    document = "native-document-1",
    executeCount = 0,
    controlCount = 0;
  const api = {
    runtime: { id: "extension", getURL: (p) => `chrome-extension://extension/${p}` },
    windows: {
      getLastFocused: async () => structuredClone(window),
      get: async () => structuredClone(window),
    },
    webNavigation: {
      getFrame: async () => ({
        url: window.tabs[0].url,
        documentId: document,
        parentFrameId: -1,
        errorOccurred: false,
      }),
    },
    permissions: { contains: async () => allowed },
    scripting: {
      executeScript: async ({ args }) => {
        executeCount++;
        if (args[0].operation === "control") controlCount++;
        return [
          {
            frameId: 0,
            documentId: document,
            result: {
              documentId: args[0].documentId,
              media: {
                id,
                title: "Lecture",
                artist: "",
                playing: true,
                positionSec: 4,
                canNext: false,
                canPrevious: false,
              },
            },
          },
        ];
      },
    },
  };
  let identityCounter = 0;
  const bridge = createBridge(api, {
    profileId: id,
    randomId: () => (++identityCounter).toString(16).padStart(32, "0"),
  });
  return {
    bridge,
    api,
    get window() {
      return window;
    },
    set window(w) {
      window = w;
    },
    set allowed(v) {
      allowed = v;
    },
    set document(v) {
      document = v;
    },
    get executes() {
      return executeCount;
    },
    get controls() {
      return controlCount;
    },
  };
}
test("unpaired bridge never queries or runs webpage code", async () => {
  const f = fixture();
  const r = await f.bridge.handle(request());
  assert.equal(r.error, "unpaired");
  assert.equal(f.executes, 0);
});
test("probe requires explicit normal focused finite browser window", async () => {
  for (const patch of [
    { incognito: true },
    { incognito: undefined },
    { focused: false },
    { width: NaN },
    { left: Infinity },
  ]) {
    const f = fixture();
    f.bridge.setPaired(true);
    Object.assign(f.window, patch);
    const r = await f.bridge.handle(request());
    assert.ok(r.error);
    assert.equal(f.executes, 0);
  }
});
test("normal probe needs no host permission or script execution", async () => {
  const f = fixture();
  f.bridge.setPaired(true);
  f.allowed = false;
  const r = await f.bridge.handle(request());
  assert.equal(r.window.incognito, false);
  assert.equal(r.window.left, -1200);
  assert.equal(r.window.tab.documentId.length, 32);
  assert.equal(f.executes, 0);
});
test("media refuses missing website grant; control requires exact identity", async () => {
  const f = fixture();
  f.bridge.setPaired(true);
  const p = await f.bridge.handle(request());
  f.allowed = false;
  const r = await f.bridge.handle(
    request("media", { windowId: 7, tabId: 9, documentId: p.window.tab.documentId }),
  );
  assert.equal(r.error, "permission_denied");
  const bad = await f.bridge.handle(
    request("control", { windowId: 7, tabId: 9, documentId: id, mediaId: id, action: "play" }),
  );
  assert.ok(bad.error);
  assert.equal(f.controls, 0);
});
test("navigation during deferred permission check refuses injection", async () => {
  const f = fixture();
  f.bridge.setPaired(true);
  const p = await f.bridge.handle(request());
  let resolve;
  f.api.permissions.contains = () => new Promise((r) => (resolve = r));
  const pending = f.bridge.handle(
    request("media", { windowId: 7, tabId: 9, documentId: p.window.tab.documentId }),
  );
  await new Promise(setImmediate);
  f.document = "native-document-2";
  f.bridge.invalidate(9);
  resolve(true);
  assert.equal((await pending).error, "changed");
  assert.equal(f.executes, 0);
});
test("revocation and replacement after script result discard metadata", async () => {
  const f = fixture();
  f.bridge.setPaired(true);
  const p = await f.bridge.handle(request());
  f.api.scripting.executeScript = async ({ args }) => {
    f.allowed = false;
    f.bridge.revoke();
    return [
      { frameId: 0, documentId: "native-document-1", result: { documentId: args[0].documentId } },
    ];
  };
  const result = await f.bridge.handle(
    request("media", { windowId: 7, tabId: 9, documentId: p.window.tab.documentId }),
  );
  assert.ok(result.error);
  assert.equal(result.media, undefined);
});
test("strict request shape prevents arbitrary actions and payloads", async () => {
  const f = fixture();
  f.bridge.setPaired(true);
  for (const extra of [
    { operation: "eval" },
    { script: "alert(1)" },
    { nonce: "x" },
    { generation: 0 },
    { action: "delete" },
  ]) {
    assert.equal((await f.bridge.handle({ ...request(), ...extra })).error, "invalid_request");
  }
  assert.equal(f.executes, 0);
});
test("foreign profile and stale native sequence/generation cannot use this profile", async () => {
  const f = fixture();
  f.bridge.setPaired(true);
  const first = request();
  await f.bridge.handle(first);
  assert.equal(
    (await f.bridge.handle({ ...request(), profileId: "c".repeat(32) })).error,
    "unpaired",
  );
  assert.equal(
    (await f.bridge.handle({ ...request(), sequence: first.sequence })).error,
    "changed",
  );
  assert.equal((await f.bridge.handle({ ...request(), generation: 0 })).error, "invalid_request");
  f.bridge.reset();
  assert.equal((await f.bridge.handle({ ...request(), sequence: 1 })).status, "ok");
});
test("top-frame browser-document injection target and returned frame identity must agree", async () => {
  const f = fixture();
  f.bridge.setPaired(true);
  const p = await f.bridge.handle(request());
  f.api.scripting.executeScript = async (injection) => {
    assert.deepEqual(injection.target, { tabId: 9, documentIds: ["native-document-1"] });
    return [
      {
        frameId: 4,
        documentId: "native-document-1",
        result: { documentId: p.window.tab.documentId },
      },
    ];
  };
  assert.equal(
    (
      await f.bridge.handle(
        request("media", { windowId: 7, tabId: 9, documentId: p.window.tab.documentId }),
      )
    ).error,
    "changed",
  );
});
test("missing Firefox document IDs use navigation-scoped identities and never guess a replacement", async () => {
  const f = fixture();
  f.bridge.setPaired(true);
  let n = 0;
  f.api.runtime.getBrowserInfo = async () => ({ name: "Firefox" });
  f.api.webNavigation.getFrame = async () => ({
    url: f.window.tabs[0].url,
    parentFrameId: -1,
    errorOccurred: false,
  });
  const p = await f.bridge.handle(request());
  f.api.scripting.executeScript = async ({ target, args }) => {
    assert.deepEqual(target, { tabId: 9, frameIds: [0] });
    n++;
    return [
      {
        frameId: 0,
        result: {
          documentId: args[0].documentId,
          media: {
            id,
            title: "Lecture",
            artist: "",
            playing: true,
            positionSec: 4,
            canNext: false,
            canPrevious: false,
          },
        },
      },
    ];
  };
  const good = await f.bridge.handle(
    request("media", { windowId: 7, tabId: 9, documentId: p.window.tab.documentId }),
  );
  assert.equal(good.status, "ok");
  f.bridge.invalidate(9);
  const stale = await f.bridge.handle(
    request("media", { windowId: 7, tabId: 9, documentId: p.window.tab.documentId }),
  );
  assert.equal(stale.error, "changed");
  assert.equal(n, 1);
});

test("explicit native-mapped window can remain unfocused; discovery cannot", async () => {
  const f = fixture();
  f.bridge.setPaired(true);
  f.window.focused = false;
  assert.equal((await f.bridge.handle(request())).error, "unfocused");
  const p = await f.bridge.handle(request("probe", { windowId: 7 }));
  assert.equal(p.status, "ok");
  assert.equal(p.window.focused, false);
  const m = await f.bridge.handle(
    request("media", { windowId: 7, tabId: 9, documentId: p.window.tab.documentId }),
  );
  assert.equal(m.status, "ok");
});
