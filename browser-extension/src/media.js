/** Serialized into the top frame's ISOLATED world. Keep every helper inside this function. */
export async function isolatedMedia(command) {
  "use strict";
  const token = (value) => typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
  if (!command || !["media", "control"].includes(command.operation) || !token(command.documentId))
    return { error: "invalid_request" };
  if (globalThis.top !== globalThis.self) return { error: "unfocused" };
  const key = "__neb_private_media_state_v1__";
  let state = globalThis[key];
  if (!state || (command.operation === "media" && state.documentId !== command.documentId)) {
    if (command.operation === "control") return { error: "changed" };
    state = { documentId: command.documentId, ids: new WeakMap() };
    Object.defineProperty(globalThis, key, { value: state, writable: true, configurable: true });
  }
  if (state.documentId !== command.documentId) return { error: "changed" };
  const elements = Array.from(document.querySelectorAll("audio, video"));
  if (elements.length > 64) return { error: "ambiguous" };
  const media = elements.filter(
    (element) =>
      element instanceof HTMLMediaElement &&
      element.isConnected &&
      element.readyState > 0 &&
      !element.ended,
  );
  const playing = media.filter((element) => !element.paused && !element.ended);
  const candidates = playing.length ? playing : media;
  if (candidates.length !== 1) return { error: candidates.length ? "ambiguous" : "no_media" };
  const element = candidates[0];
  let identity = state.ids.get(element);
  const source = String(element.currentSrc || element.src || "");
  const sourceObject = element.srcObject ?? null;
  let mediaId =
    identity?.source === source && identity?.sourceObject === sourceObject ? identity.id : null;
  if (!mediaId) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    mediaId = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    state.ids.set(element, { source, sourceObject, id: mediaId });
  }
  if (command.operation === "control") {
    if (!token(command.mediaId) || command.mediaId !== mediaId) return { error: "changed" };
    if (!["play", "pause"].includes(command.action)) return { error: "unsupported" };
    if (command.action === "play") {
      let timer;
      try {
        await Promise.race([
          HTMLMediaElement.prototype.play.call(element),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("Playback did not settle.")), 2500);
          }),
        ]);
      } catch {
        return { error: "unavailable" };
      } finally {
        clearTimeout(timer);
      }
    } else HTMLMediaElement.prototype.pause.call(element);
    if (
      !element.isConnected ||
      state !== globalThis[key] ||
      state.documentId !== command.documentId ||
      String(element.currentSrc || element.src || "") !== source ||
      (element.srcObject ?? null) !== sourceObject ||
      state.ids.get(element)?.id !== mediaId
    )
      return { error: "changed" };
  }
  const clean = (value) =>
    typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200) : "";
  const metadata = navigator.mediaSession?.metadata;
  const position = Number(element.currentTime);
  if (!Number.isFinite(position) || position < 0 || position > 86400)
    return { error: "unavailable" };
  return {
    documentId: state.documentId,
    media: {
      id: mediaId,
      title: clean(metadata?.title),
      artist: clean(metadata?.artist),
      playing: !element.paused && !element.ended,
      positionSec: position,
      canNext: false,
      canPrevious: false,
    },
  };
}
