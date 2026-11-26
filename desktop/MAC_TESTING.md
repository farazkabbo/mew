# Testing the current Mac build

Neb remains one shared Tauri app and repository. The Mac app uses WKWebView; Windows uses WebView2. Native services differ where the operating systems require it. This development build does **not** yet have every Windows feature.

## Open the build

Quit an older running Neb first, then open:

`desktop/src-tauri/target/debug/bundle/macos/Neb.app`

The notebook defaults to the local web app at `http://localhost:3000`, unless `MEW_APP_URL` was configured. Keep your existing local preview running for notebook testing. Native tools/settings can be tested without model API keys.

## Test the available controls

1. Use Neb's menu-bar icon → **Screen Coach settings…**.
2. Read and enable **Allow visible Mac overlays** only if it is okay for your drawings and music details to appear in recordings or screen shares. Save preferences. This does not enable screen capture.
3. Choose **Show or hide Neb tools**. Switch to an ordinary app, then use Pen/Eraser. Clear removes the local notes; Close or Escape cancels the tools. Changing app/window/display also cancels annotations. Scroll anchoring still needs implementation/testing.
4. Open Music with Spotify or Apple Music already running. macOS may ask you to grant Automation access. Opening this panel is the explicit request; Neb does not query/control players at startup. Test play/pause/previous/next. Denial or timeout must show a truthful notice without repeatedly prompting; close/reopen is an explicit retry.
5. In Spotify, copy a playlist/album link, then select **Pin copied Spotify link**. Its public name may be fetched from Spotify. Test opening and unpinning; reopen Neb and verify retained pins. No Spotify login or developer key is used by this feature.
6. Pause tools or turn off visible overlays and save. Drawings and media metadata must disappear, and pending pin/media work must not reappear. Test Escape while only Music is open too.
7. Press **Control + Shift + N** from another app; the notebook should come forward as before.

Playback, clipboard and opening tests are manual acceptance steps, **not claims that automation tests have controlled your actual players or clipboard**. Automated coverage uses synthetic services. The native indicator fixture has produced successful presentation/revocation results for its own red border, but also bounded timeouts. Its runtime reliability remains open; it never captures screen contents.

## Still unavailable

Screen capture/voice/Ask, Circle & Ask and clips, Watch/study flows, cursor modes and Handoff still need production wiring and Mac acceptance. Browser media/artwork and some native interaction matrices remain open. Adding API keys does not enable an unwired native service. See [the full parity ledger](../docs/MAC_PARITY.md).

The app is a local ARM64 development bundle. Ad hoc signature verification is separate from Developer ID signing, notarization, production DMG distribution and a signed-update test. Those release gates remain open.

## Rebuild locally

From the repository root:

```sh
MACOSX_DEPLOYMENT_TARGET=14.0 pnpm --filter @mew/desktop exec tauri build --debug --bundles app --config src-tauri/tauri.macos.conf.json
codesign --force --sign - --options runtime --entitlements desktop/src-tauri/Entitlements.plist desktop/src-tauri/target/debug/bundle/macos/Neb.app
codesign --verify --strict desktop/src-tauri/target/debug/bundle/macos/Neb.app
```

This local signature uses no publisher credentials and does not make the build a notarized public release. Release/update preparation is described in [MAC_UPDATES.md](MAC_UPDATES.md).
