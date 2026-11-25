# Preparing macOS updates

Mac builds use the shared updater state, background download and local Settings/tray actions.
Installation starts only from the student's Restart to update action. After the plugin verifies
and installs the archive, macOS explicitly restarts the app; the Windows installer retains its
existing restart behavior. Debug builds and builds without an updater public key and HTTPS
endpoint show Updates are off. The Mac configuration intentionally has neither a feed nor a
key: the existing Windows feed does not establish a published Mac release.

A DMG is for manual installation. Tauri Updater needs the separately signed `.app.tar.gz` and
sibling `.app.tar.gz.sig` from `bundle/macos`, using the Tauri update signing key. Apple Developer
ID signing and notarization are separate requirements for distribution.

To prepare artifacts, merge `tauri.macos.conf.json`, `tauri.macos.release.conf.json`, and a local
release configuration containing the **actual** publisher's updater public key and HTTPS
endpoint. The checked-in release overlay only enables artifact creation. For example, from
`desktop`, with signing credentials already configured outside the repository:

```sh
pnpm exec tauri build --target aarch64-apple-darwin --config src-tauri/tauri.macos.conf.json --config src-tauri/tauri.macos.release.conf.json --config /path/to/approved-updater-config.json
```

Repeat for `x86_64-apple-darwin` if Intel is supported. Keep the resulting archives and their
signatures tied to the same reviewed version and rename each architecture's archive and sibling
signature consistently before putting them in one public folder. Do not label an ARM archive as
Intel. Manifest inputs are explicit because the archive filename does not prove its architecture:

```sh
pnpm update-manifest --base-url https://publisher.example/desktop/ --artifact darwin-aarch64=/release/Neb-arm.app.tar.gz --artifact darwin-x86_64=/release/Neb-intel.app.tar.gz --out /release/latest.json
```

Include `--artifact windows-x86_64=/release/Neb_VERSION_x64-setup.exe` in that same invocation
when preparing a shared manifest; the output lists exactly the supplied platforms. Omitting a
platform removes it from the generated manifest, so preserve every supported release entry
before replacing a shared feed. The existing no-`--artifact` invocation still generates the
Windows NSIS manifest in its existing output folder. Every input needs a nonempty artifact and
sibling signature; local preparation does not upload or install anything, and does not verify
the signature cryptographically. The installed updater verifies it against its trusted key.

Before publishing, verify the actual archive architectures, signing and notarization, and test
an upgrade from an installed older release for each supported architecture: valid signature,
wrong/missing signature rejection, successful restart, unchanged settings/account data, and a
student declining or postponing the update. A local compile or manifest test does not verify
these release gates. No Mac feed, signed/notarized release, or installed-app upgrade was verified
by this implementation.

References: [Tauri Updater](https://v2.tauri.app/plugin/updater/),
[macOS signing](https://v2.tauri.app/distribute/sign/macos/).
