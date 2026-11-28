import { isolatedMedia } from "./media.js";
export const NATIVE_HOST = "com.neb.browser_companion";
export const ERRORS = new Set([
  "unpaired",
  "invalid_request",
  "private",
  "unfocused",
  "permission_denied",
  "changed",
  "ambiguous",
  "no_media",
  "unsupported",
  "unavailable",
]);
const hex = (value, length) =>
  typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`).test(value);
export function randomId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
function validRequest(r) {
  if (
    !r ||
    Object.getPrototypeOf(r) !== Object.prototype ||
    Object.keys(r).some(
      (k) =>
        ![
          "type",
          "version",
          "nonce",
          "sequence",
          "profileId",
          "generation",
          "operation",
          "windowId",
          "tabId",
          "documentId",
          "mediaId",
          "action",
        ].includes(k),
    )
  )
    return false;
  if (
    r.type !== "request" ||
    !hex(r.profileId, 32) ||
    r.version !== 1 ||
    !hex(r.nonce, 32) ||
    !Number.isSafeInteger(r.sequence) ||
    r.sequence < 1 ||
    !Number.isSafeInteger(r.generation) ||
    r.generation < 1 ||
    !["probe", "media", "control"].includes(r.operation)
  )
    return false;
  if (
    (r.windowId !== undefined && !integer(r.windowId)) ||
    (r.tabId !== undefined && !integer(r.tabId)) ||
    (r.documentId !== undefined && !hex(r.documentId, 32)) ||
    (r.mediaId !== undefined && !hex(r.mediaId, 32)) ||
    (r.action !== undefined && !["play", "pause", "next", "previous"].includes(r.action))
  )
    return false;
  if (r.operation === "probe") return r.mediaId === undefined && r.action === undefined;
  if (!integer(r.windowId) || !integer(r.tabId) || !hex(r.documentId, 32)) return false;
  return r.operation === "control"
    ? hex(r.mediaId, 32) && r.action !== undefined
    : r.mediaId === undefined && r.action === undefined;
}
function publicURL(value) {
  try {
    const u = new URL(value);
    return ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      u.href.length <= 2000
      ? u
      : null;
  } catch {
    return null;
  }
}
function windowIdentity(w, requireFocus) {
  if (w?.incognito !== false) throw new Error("private");
  if (w.type !== "normal") throw new Error("unavailable");
  if (typeof w.focused !== "boolean") throw new Error("unavailable");
  if (requireFocus && w.focused !== true) throw new Error("unfocused");
  if (
    !integer(w.id) ||
    !["left", "top", "width", "height"].every((k) => Number.isFinite(w[k])) ||
    w.width <= 0 ||
    w.height <= 0 ||
    w.width > 32768 ||
    w.height > 32768
  )
    throw new Error("unavailable");
  const active = w.tabs?.filter((t) => t.active === true);
  if (active?.length !== 1) throw new Error("changed");
  const tab = active[0];
  if (!integer(tab.id) || !publicURL(tab.url) || typeof tab.title !== "string")
    throw new Error("unavailable");
  return {
    window: {
      id: w.id,
      focused: w.focused,
      incognito: false,
      left: w.left,
      top: w.top,
      width: w.width,
      height: w.height,
      tab: {
        id: tab.id,
        url: tab.url,
        title: tab.title.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200),
      },
    },
    origin: `${publicURL(tab.url).origin}/*`,
  };
}
export function createBridge(
  api,
  { profileId, randomId: makeId = randomId, onDocumentsChanged = () => {} } = {},
) {
  if (!hex(profileId, 32)) throw new Error("Invalid profile ID");
  let paired = false,
    epoch = 0,
    latestSequence = 0,
    latestGeneration = 0;
  const documents = new Map();
  const seen = new Set();
  const fail = (error) => {
    throw new Error(error);
  };
  const invalidate = (tabId) => {
    epoch++;
    if (tabId === undefined) documents.clear();
    else documents.delete(tabId);
    onDocumentsChanged([...documents.entries()]);
  };
  async function identity(windowId) {
    const w =
      windowId === undefined
        ? await api.windows.getLastFocused({ populate: true, windowTypes: ["normal"] })
        : await api.windows.get(windowId, { populate: true });
    const result = windowIdentity(w, windowId === undefined);
    if (windowId !== undefined && result.window.id !== windowId) fail("changed");
    const frame = await api.webNavigation.getFrame({ tabId: result.window.tab.id, frameId: 0 });
    if (
      !frame ||
      frame.errorOccurred !== false ||
      frame.parentFrameId !== -1 ||
      frame.url !== result.window.tab.url ||
      (frame.documentLifecycle !== undefined && frame.documentLifecycle !== "active") ||
      (frame.frameType !== undefined && frame.frameType !== "outermost_frame")
    )
      fail("changed");
    const browserDocument = typeof frame.documentId === "string" ? frame.documentId : null;
    let stored = documents.get(result.window.tab.id);
    if (!stored || stored.url !== frame.url || stored.browserDocument !== browserDocument) {
      const id =
        browserDocument === null
          ? makeId()
          : Array.from(
              new Uint8Array(
                await crypto.subtle.digest(
                  "SHA-256",
                  new TextEncoder().encode(`${profileId}:${browserDocument}`),
                ),
              ),
              (b) => b.toString(16).padStart(2, "0"),
            )
              .join("")
              .slice(0, 32);
      stored = { url: frame.url, browserDocument, id };
      documents.set(result.window.tab.id, stored);
      onDocumentsChanged([...documents.entries()]);
    }
    result.window.tab.documentId = stored.id;
    result.browserDocument = browserDocument;
    return result;
  }
  const same = (a, b) =>
    JSON.stringify(a.window) === JSON.stringify(b.window) &&
    a.browserDocument === b.browserDocument;
  async function handle(request) {
    const base = {
      type: "response",
      version: 1,
      nonce: request?.nonce,
      generation: request?.generation,
      profileId,
      sequence: request?.sequence,
    };
    try {
      if (!validRequest(request)) fail("invalid_request");
      if (request.profileId !== profileId) fail("unpaired");
      if (!paired) fail("unpaired");
      if (seen.has(request.nonce)) fail("invalid_request");
      seen.add(request.nonce);
      if (seen.size > 2048) seen.delete(seen.values().next().value);
      if (request.sequence <= latestSequence || request.generation < latestGeneration)
        fail("changed");
      latestSequence = request.sequence;
      if (request.generation > latestGeneration) {
        latestGeneration = request.generation;
        epoch++;
      }
      const ticket = epoch;
      const current = () => paired && ticket === epoch;
      const before = await identity(request.windowId);
      if (!current()) fail("changed");
      if (
        (request.tabId !== undefined && request.tabId !== before.window.tab.id) ||
        (request.documentId !== undefined && request.documentId !== before.window.tab.documentId)
      )
        fail("changed");
      if (request.operation === "probe") {
        const after = await identity(before.window.id);
        if (!current() || !same(before, after)) fail("changed");
        return { ...base, status: "ok", window: after.window };
      }
      if (!(await api.permissions.contains({ origins: [before.origin] })))
        fail("permission_denied");
      const ready = await identity(before.window.id);
      if (!current() || !same(before, ready)) fail("changed");
      const command = {
        operation: request.operation,
        documentId: request.documentId,
        ...(request.operation === "control" && {
          mediaId: request.mediaId,
          action: request.action,
        }),
      };
      const results = await api.scripting.executeScript({
        target: {
          tabId: request.tabId,
          ...(before.browserDocument !== null && !api.runtime.getBrowserInfo
            ? { documentIds: [before.browserDocument] }
            : { frameIds: [0] }),
        },
        world: "ISOLATED",
        func: isolatedMedia,
        args: [command],
      });
      if (!current()) fail("changed");
      const after = await identity(before.window.id);
      if (!current() || !same(before, after)) fail("changed");
      if (!(await api.permissions.contains({ origins: [before.origin] })) || !current())
        fail("permission_denied");
      if (
        !Array.isArray(results) ||
        results.length !== 1 ||
        results[0].frameId !== 0 ||
        (before.browserDocument !== null && results[0].documentId !== before.browserDocument)
      )
        fail("changed");
      const value = results[0].result;
      if (ERRORS.has(value?.error)) fail(value.error);
      const m = value?.media;
      if (
        value?.documentId !== request.documentId ||
        !m ||
        !hex(m.id, 32) ||
        typeof m.title !== "string" ||
        m.title.length > 200 ||
        typeof m.artist !== "string" ||
        m.artist.length > 200 ||
        typeof m.playing !== "boolean" ||
        !Number.isFinite(m.positionSec) ||
        m.positionSec < 0 ||
        m.positionSec > 86400 ||
        m.canNext !== false ||
        m.canPrevious !== false
      )
        fail("unavailable");
      return {
        ...base,
        status: "ok",
        window: after.window,
        media: {
          id: m.id,
          title: m.title || after.window.tab.title,
          artist: m.artist,
          playing: m.playing,
          positionSec: m.positionSec,
          canNext: false,
          canPrevious: false,
        },
      };
    } catch (error) {
      return {
        ...base,
        status: "error",
        error: ERRORS.has(error?.message) ? error.message : "unavailable",
      };
    }
  }
  return {
    handle,
    invalidate,
    reset: () => {
      invalidate();
      seen.clear();
      latestSequence = 0;
      latestGeneration = 0;
    },
    revoke: () => invalidate(),
    setPaired: (value) => {
      paired = value === true;
      invalidate();
    },
    profileId,
  };
}
