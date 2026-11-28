# Mac browser companion

Neb's Mac app keeps the same notebook and native Screen Coach as Windows. The companion is a
small, separately enabled browser extension. It fills a gap in public Mac APIs: a native app
cannot reliably infer whether every browser window is private or control every website's
player. The browser can report its own window state, while Neb verifies which native window
that report belongs to.

## What goes where

- `browser-extension/src`: browser-profile connection, permission requests and a fixed media
  probe. No screenshots, entered form text, notebook credentials or API keys cross this bridge.
- `desktop/src-tauri/src/browser_companion_protocol.rs`: bounded, versioned messages. Every
  reply must match a fresh request, connection, profile, sequence, generation and document.
- `browser_companion_auth.rs`: native process and code-signature checks. A browser name or
  message by itself cannot establish trust.
- `browser_companion_server.rs`: local Unix socket, explicit profile pairing and revocation.
  Pairings stay in the user's private application-support folder.
- `browser_companion_install.rs`: explicit per-user Chrome, Brave, Edge, Chromium and Firefox
  native-host registration. It refuses unrelated files and symlinks.
- `src/bin/neb-browser-host.rs`: the small helper connecting browser native messaging to Neb.
  It forwards bounded messages; it cannot call an API provider or capture a screen.
- `screen/mac/browser_bridge.rs`: matches a browser window to the exact native process launch,
  focused Accessibility window and unique Quartz geometry. Browser window IDs and Mac window
  IDs are different and are never interchangeable.

Capture still requires the existing local consent, Screen Recording and Accessibility
permissions, ordinary rather than password focus, call checks, target revalidation and OCR
redaction. Pairing does not grant any of those permissions. Missing, private, ambiguous,
changed or disconnected evidence refuses the operation.

## Local installation and pairing

1. Build the companion with `pnpm --filter @mew/browser-companion build`.
2. Build the Mac application and run the resulting `Neb.app`. Host installation requires the
   embedded helper beside the main executable in the app bundle.
3. In Neb's local Screen Coach settings, choose the browser and select **Install local browser
   connection**. This registers only this user's native host; it does not force an extension
   into a browser or enable private access.
4. In a Chromium browser, load `browser-extension/dist/chromium` as an unpacked extension for
   development. In Firefox, load the generated Firefox manifest as a temporary development
   add-on. Distribution requires the browser's extension signing/publishing workflow.
5. Open the extension's toolbar and select **Pair this profile with Neb**. In Neb settings,
   refresh profiles, check the browser and signing publisher, then approve the intended profile.
   Each browser profile pairs separately. An ordinary reconnect cannot approve a new profile.
6. On a website where you want playback controls, choose **Enable media on this website** in
   the extension popup. The browser asks for that exact site's permission. A Mac hotkey cannot
   grant website access.
7. Revoke a pairing in Neb to remove native trust. Website permission can also be removed in
   the browser. Removing the native host registration alone does not erase saved pairings.

The development Chromium key in this repository is public extension identification material.
It is not an authentication secret. Production browser-store IDs must be configured in both
the extension and native allowlist. Development app signatures do not substitute for a signed,
notarized release from the owner's Developer ID team.

## Media boundaries

The extension can read a unique top-frame HTML audio/video player on an explicitly permitted
site and issue fixed play or pause actions. Ambiguous players, permission revocation, private
windows, navigation and changed sources are refused. It cannot execute scripts supplied by a
model or native request. Generic website next/previous and browser artwork are not implemented.
Embedded cross-origin players require their own verified support; top-frame detection does not
claim to cover them.

Native media adapters also cover Spotify, Music, TV, VLC and QuickTime using inspected public
interfaces. QuickTime must first expose a playing, unmodified, local movie; an unseen paused
QuickTime document is refused because its public dictionary does not establish recording
absence. Recording stop/pause commands are never used. Native tests and JavaScript mocks do
not establish that every installed player version behaves identically.

## Safari boundary

The Safari build is extension source, not a working Safari installation. Safari routes native
messages through its containing app extension. The signed native Safari handler, containing-app
packaging and transport integration still need implementation and verification. Safari release
configuration is blocked until an Apple Developer team is available. Apple describes the
[containing-app native messaging path](https://developer.apple.com/documentation/safariservices/messaging-between-the-app-and-javascript-in-a-safari-web-extension)
and [Developer Program distribution requirement](https://developer.apple.com/documentation/safariservices/safari-web-extensions). A Chromium or
Firefox native-host manifest does not provide this. Do not mark Safari parity complete because
the JavaScript bundle builds.

## Manual acceptance

Use a synthetic lesson and a test media page, rather than private browsing data.

- Pair each profile independently; confirm an unapproved profile cannot provide evidence.
- Restart Neb and the browser; confirm the approved profile reconnects and revocation stops it.
- Open normal and private windows side by side; confirm private/unknown windows refuse capture.
- Move/resize a window, switch tabs during a request, navigate and restart the browser; stale
  windows, process IDs, documents and controls must never inherit permission.
- Grant one website media access, verify its unique player's play/pause, then remove access.
  Playback should become unavailable without another action being sent.
- Test Retina and external displays, including negative screen coordinates and overlapping
  browser windows. Ambiguous native mappings must refuse rather than guess.
- With a Circle card or keyboard drawing focused, confirm retained evidence stays tied to the
  original source. Closing/replacing the source must invalidate the session.
- Check TV, VLC and QuickTime movie controls with local synthetic media. Verify QuickTime
  recording documents are unavailable and that disabled skip controls remain disabled.

Automated checks are recorded in the branch's verification results. Browser installation,
real OS focus transitions and playback remain separate manual checks.
