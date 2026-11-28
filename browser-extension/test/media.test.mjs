import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { isolatedMedia } from "../src/media.js";
function frame() {
  class Media {
    constructor() {
      this.isConnected = true;
      this.readyState = 4;
      this.ended = false;
      this.paused = false;
      this.currentTime = 12;
      this.currentSrc = "https://example.com/video";
      this.plays = 0;
      this.pauses = 0;
    }
    async play() {
      this.plays++;
      this.paused = false;
    }
    pause() {
      this.pauses++;
      this.paused = true;
    }
  }
  const element = new Media(),
    elements = [element];
  const context = {
    HTMLMediaElement: Media,
    setTimeout,
    clearTimeout,
    document: {
      visibilityState: "visible",
      hasFocus: () => true,
      querySelectorAll: (selector) => {
        assert.equal(selector, "audio, video");
        return elements;
      },
    },
    navigator: { mediaSession: { metadata: { title: "A lecture", artist: "Teacher" } } },
    crypto: webcrypto,
    Uint8Array,
  };
  context.top = context;
  context.self = context;
  vm.createContext(context);
  const call = (args) =>
    vm.runInContext(`(${isolatedMedia.toString()})(${JSON.stringify(args)})`, context);
  return { element, elements, context, call };
}
const documentId = "d".repeat(32);
test("fixed top-frame media reader returns only bounded playback metadata", async () => {
  const f = frame();
  const r = await f.call({ operation: "media", documentId });
  assert.equal(r.media.title, "A lecture");
  assert.equal(r.media.id.length, 32);
  assert.equal(r.media.positionSec, 12);
  assert.equal(r.media.canNext, false);
  assert.deepEqual(Object.keys(r.media).sort(), [
    "artist",
    "canNext",
    "canPrevious",
    "id",
    "playing",
    "positionSec",
    "title",
  ]);
});
test("control cannot run without a previously observed exact media identity", async () => {
  const f = frame();
  assert.equal(
    (await f.call({ operation: "control", documentId, mediaId: "e".repeat(32), action: "play" }))
      .error,
    "changed",
  );
  assert.equal(f.element.plays, 0);
});
test("controls invoke only fixed intrinsic methods and reject next/previous without adapter", async () => {
  const f = frame();
  const p = await f.call({ operation: "media", documentId });
  await f.call({ operation: "control", documentId, mediaId: p.media.id, action: "pause" });
  assert.equal(f.element.pauses, 1);
  assert.equal(
    (await f.call({ operation: "control", documentId, mediaId: p.media.id, action: "next" })).error,
    "unsupported",
  );
});
test("same HTML media element with changed source cannot reuse old capability", async () => {
  const f = frame();
  const p = await f.call({ operation: "media", documentId });
  f.element.currentSrc = "https://example.com/replacement";
  assert.equal(
    (await f.call({ operation: "control", documentId, mediaId: p.media.id, action: "pause" }))
      .error,
    "changed",
  );
  assert.equal(f.element.pauses, 0);
});
test("multiple playing elements and non-top frames are refused; background media remains available", async () => {
  const f = frame();
  f.elements.push(new f.context.HTMLMediaElement());
  assert.equal((await f.call({ operation: "media", documentId })).error, "ambiguous");
  f.elements.pop();
  f.context.document.visibilityState = "hidden";
  assert.ok((await f.call({ operation: "media", documentId })).media);
  f.context.document.visibilityState = "visible";
  f.context.top = {};
  assert.equal((await f.call({ operation: "media", documentId })).error, "unfocused");
});
test("navigation/replacement during awaited play never reports success", async () => {
  const f = frame();
  f.element.paused = true;
  const p = await f.call({ operation: "media", documentId });
  let resolve;
  f.context.HTMLMediaElement.prototype.play = function () {
    this.plays++;
    return new Promise((r) => (resolve = r));
  };
  const pending = f.call({ operation: "control", documentId, mediaId: p.media.id, action: "play" });
  f.element.isConnected = false;
  resolve();
  assert.equal((await pending).error, "changed");
  assert.equal(f.element.plays, 1);
});

test("source replacement during awaited play discards old playback acknowledgment", async () => {
  const f = frame();
  f.element.paused = true;
  const p = await f.call({ operation: "media", documentId });
  let resolve;
  f.context.HTMLMediaElement.prototype.play = function () {
    this.plays++;
    return new Promise((r) => (resolve = r));
  };
  const pending = f.call({ operation: "control", documentId, mediaId: p.media.id, action: "play" });
  f.element.currentSrc = "https://example.com/new-track";
  resolve();
  assert.equal((await pending).error, "changed");
  assert.equal(f.element.plays, 1);
});
