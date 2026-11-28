import { createBridge, NATIVE_HOST, randomId } from "./bridge.js";
export function installBackground(
  api,
  { target = "chromium", schedule = setTimeout, cancelSchedule = clearTimeout } = {},
) {
  let port = null,
    reconnectTimer = null,
    connectionEpoch = 0;
  const queues = new WeakMap();
  const ready = (async () => {
    const saved = await api.storage.local.get(["profileId", "pairRequested"]);
    const profileId = /^[0-9a-f]{32}$/.test(saved.profileId ?? "") ? saved.profileId : randomId();
    await api.storage.local.set({ profileId });
    const bridge = createBridge(api, {
      profileId,
      onDocumentsChanged: (documents) => {
        if (api.storage.session)
          void api.storage.session
            .set({ nebNavigation: { profileId, documents } })
            .catch(() => undefined);
      },
    });
    if (api.storage.session?.setAccessLevel)
      await api.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    bridge.setPaired(saved.pairRequested === true);
    return { bridge, profileId, pairRequested: saved.pairRequested === true };
  })();
  function popupSender(sender) {
    return (
      sender?.id === api.runtime.id &&
      sender.tab === undefined &&
      sender.url === api.runtime.getURL("popup.html")
    );
  }
  async function sendNative(message, selectedPort) {
    if (port !== selectedPort) return;
    if (target === "safari") {
      const reply = await api.runtime.sendNativeMessage(NATIVE_HOST, message);
      if (reply?.type === "request" && selectedPort === port) enqueue(reply, selectedPort);
    } else selectedPort.postMessage(message);
  }
  function enqueue(message, selectedPort) {
    // Do not execute queued controls from a disconnected connection, or overlap native actions.
    const next = (queues.get(selectedPort) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        if (port !== selectedPort || message?.type !== "request") return;
        const state = await ready;
        const response = await state.bridge.handle(message);
        if (port === selectedPort) await sendNative(response, selectedPort);
      })
      .catch(() => undefined);
    queues.set(selectedPort, next);
  }
  async function connect(explicitPair = false) {
    const state = await ready;
    if (!state.pairRequested && !explicitPair) return;
    cancelSchedule(reconnectTimer);
    if (port) {
      const previous = port;
      port = null;
      previous.disconnect();
    }
    state.bridge.reset();
    connectionEpoch++;
    if (
      typeof api.runtime.connectNative !== "function" ||
      (target === "safari" && typeof api.runtime.sendNativeMessage !== "function")
    )
      throw new Error("Native messaging is unavailable.");
    const selectedPort = api.runtime.connectNative(NATIVE_HOST);
    port = selectedPort;
    selectedPort.onMessage.addListener((message) => enqueue(message, selectedPort));
    selectedPort.onDisconnect.addListener(() => {
      if (port !== selectedPort) return;
      port = null;
      state.bridge.reset();
      connectionEpoch++;
      // A reconnect only says hello. It never repeats the toolbar's pairing authorization.
      if (state.pairRequested)
        reconnectTimer = schedule(() => void connect().catch(() => undefined), 5000);
    });
    await sendNative(
      { type: explicitPair ? "pair" : "hello", version: 1, profileId: state.profileId },
      selectedPort,
    );
  }
  api.runtime.onMessage.addListener((message, sender, respond) => {
    if (
      !popupSender(sender) ||
      !message ||
      !["status", "pair", "unpair", "refresh"].includes(message.type)
    )
      return false;
    const work = (async () => {
      const state = await ready;
      if (message.type === "pair") {
        state.pairRequested = true;
        state.bridge.setPaired(true);
        await api.storage.local.set({ pairRequested: true });
        try {
          await connect(true);
        } catch {
          return { ok: false, error: "Open Neb and install its browser connection first." };
        }
        return { ok: true, message: "Pairing requested. Confirm this browser profile in Neb." };
      }
      if (message.type === "unpair") {
        state.pairRequested = false;
        state.bridge.setPaired(false);
        cancelSchedule(reconnectTimer);
        await api.storage.local.set({ pairRequested: false });
        const previous = port;
        port = null;
        previous?.disconnect();
        return { ok: true };
      }
      if (message.type === "refresh") state.bridge.revoke();
      return {
        ok: true,
        profileId: state.profileId,
        connected: port !== null,
        pairRequested: state.pairRequested,
        connectionEpoch,
      };
    })();
    work.then(respond, () =>
      respond({ ok: false, error: "The browser connection is unavailable." }),
    );
    return true;
  });
  const changed = (details) => {
    if (details.frameId === undefined || details.frameId === 0)
      void ready.then((s) => s.bridge.invalidate(details.tabId));
  };
  api.webNavigation.onBeforeNavigate.addListener(changed);
  api.webNavigation.onCommitted.addListener(changed);
  api.webNavigation.onHistoryStateUpdated.addListener(changed);
  api.webNavigation.onReferenceFragmentUpdated.addListener(changed);
  api.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status === "loading" || change.url)
      void ready.then((s) => s.bridge.invalidate(tabId));
  });
  api.tabs.onRemoved.addListener((tabId) => void ready.then((s) => s.bridge.invalidate(tabId)));
  api.tabs.onActivated.addListener(() => void ready.then((s) => s.bridge.invalidate()));
  api.windows.onFocusChanged.addListener(() => void ready.then((s) => s.bridge.invalidate()));
  api.permissions.onRemoved.addListener(() => void ready.then((s) => s.bridge.revoke()));
  void ready
    .then((state) => {
      if (state.pairRequested) return connect();
    })
    .catch(() => undefined);

  return { ready };
}
