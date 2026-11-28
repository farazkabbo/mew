# Neb browser companion

This is the explicitly installed browser-profile companion for Neb's native desktop bridge. It does not capture images, read page text, scrape inputs, or receive API credentials.

## Build and checks

From the repository root:

```sh
node --test browser-extension/test/*.test.mjs
node browser-extension/build.mjs
```

The build reuses the existing `desktop` esbuild dependency. It requires the public Chromium manifest key, matching extension ID, and fixed Firefox add-on ID in `desktop/src-tauri/browser-companion.json`. It creates separate `browser-extension/dist/chromium`, `firefox`, and `safari` source packages. Generated packages are ignored by Git. The development Chromium key is public identification material, not a signing or authentication secret; release store identifiers must be deliberately configured in the native allowlist too.

Load the Chromium package as an unpacked extension for local testing. Firefox development installations use a temporary add-on, while distribution requires Mozilla signing. Safari's package is input to Apple's Safari Web Extension Packager: Safari native messaging connects only to its containing macOS app extension, so it requires the native containing-app forwarding handler. A Chrome/Firefox native-host manifest does not install Safari support. No browser or system setting is changed by this build.

## User flow

1. Install Neb's native host `com.neb.browser_companion` through Neb's local settings.
2. Install the browser extension and open its toolbar popup in each desired browser profile.
3. Choose **Pair this profile with Neb**, then approve that profile in Neb. Reconnection sends only `hello`, never another `pair`.
4. To use website playback controls, open that website and choose **Enable media on this website**. This requests optional permission for that exact HTTP(S) origin directly from the toolbar gesture. A native hotkey cannot grant `activeTab` access.
5. Revoke website permissions through the browser's extension settings. Disconnecting the profile stops its extension transport; revoke the saved pairing in Neb to remove native trust.

Private/unknown-incognito windows are always refused, including browsers that allow enabling the add-on privately. Discovery requires a focused window. Explicit requests for a previously native-mapped window may use an unfocused window, while preserving its active tab and exact document/media identity. The extension rechecks window identity, navigation, connection lifetime, and website permission before and after asynchronous operations. `webNavigation` provides document identity without website access; a fixed isolated-world function is injected only after the website permission is already present. No page-to-extension or externally connectable message route exists. Popup messages must come from this extension's exact popup document.

Only the top frame is inspected. A unique playing HTML audio/video element is selected; otherwise a unique loaded paused element is required. Multiple candidates are refused. Its random ID changes when the element's source changes. Generic controls support play and pause through fixed media methods; next/previous are explicitly unavailable until a verified site adapter exists. No arbitrary JavaScript, selector, or DOM text is accepted from native requests. An action can have been submitted before a late navigation/revocation is detected; it is not automatically retried or reported as verified success.

## Protocol

Native requests are `{type:"request",version:1,nonce,generation,sequence,operation,...}`. `nonce`, profile, document, and media IDs are **32 lowercase hexadecimal characters** (128 bits). Sequence and generation are positive JavaScript-safe integers. `probe` without a window ID discovers a normal focused window and active HTTP(S) tab. A targeted probe may return `focused:false` for the exact native-mapped window; the native caller owns that mapping grant. `media` requires the previously observed window/tab/document tuple; `control` additionally requires the observed media ID and one fixed action. Responses echo the request identifiers and use `status:"ok"` or `status:"error"`. Errors contain only envelope identifiers and a fixed error enum.

Browser-provided document IDs are hashed with the profile ID into a 32-character token. Where the browser omits document IDs, live per-tab tokens are invalidated on navigation/loading events and reconnection. All tokens are capabilities scoped to this extension profile and connection checks, not an identity assertion from website content.

## Validation boundary

The Node suite runs mocked browser APIs and a synthetic isolated media document. It verifies denied/private/stale/malformed cases and fixed control behavior without querying personal browser tabs, prompting for permissions, or controlling real playback. Actual browser installation, native pairing, Safari packaging, OS-focus transitions, and live website behavior require the native/manual acceptance matrix.
