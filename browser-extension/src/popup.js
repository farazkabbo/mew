const api = globalThis.browser ?? globalThis.chrome;
const text = (id, value) => (document.getElementById(id).textContent = value);
const message = (value) => text("message", value);
async function refresh() {
  const state = await api.runtime.sendMessage({ type: "status" });
  text("profile", state.profileId ?? "Unavailable");
  text(
    "connection",
    state.connected
      ? "Browser connection open. Neb must approve this profile."
      : state.pairRequested
        ? "Waiting for Neb."
        : "This browser profile has not requested pairing.",
  );
  const tabs = await api.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs.length === 1 ? tabs[0] : null;
  const window = tab ? await api.windows.get(tab.windowId) : null;
  const button = document.getElementById("enable");
  button.disabled = true;
  if (window?.incognito !== false) {
    text("website", "Private windows are never shared.");
    return;
  }
  try {
    const url = new URL(tab.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new Error();
    button.dataset.origin = `${url.origin}/*`;
    text("website", url.origin);
    button.disabled = false;
  } catch {
    text("website", "Open a regular HTTP or HTTPS website to enable media.");
  }
}
document.getElementById("pair").addEventListener("click", async () => {
  try {
    const result = await api.runtime.sendMessage({ type: "pair" });
    message(result.message ?? result.error ?? "Pairing requested.");
    await refresh();
  } catch {
    message("Open Neb and install its browser connection first.");
  }
});
document.getElementById("unpair").addEventListener("click", async () => {
  await api.runtime.sendMessage({ type: "unpair" });
  message("This profile is disconnected. Remove its pairing in Neb to revoke native trust.");
  await refresh();
});
document.getElementById("enable").addEventListener("click", async (event) => {
  const origin = event.currentTarget.dataset.origin;
  if (!origin) return;
  // Must be called directly from the toolbar button gesture, never from a native hotkey.
  try {
    const allowed = await api.permissions.request({ origins: [origin] });
    await api.runtime.sendMessage({ type: "refresh" });
    message(
      allowed
        ? "Website media enabled. You can revoke this permission in browser extension settings."
        : "Website media permission was not granted.",
    );
  } catch {
    message("Website media permission could not be requested.");
  }
});
void refresh().catch(() => message("The browser connection is unavailable."));
