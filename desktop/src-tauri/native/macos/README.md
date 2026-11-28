# Native Mac capture boundary

`ScreenCapture.swift` implements the C ABI in `include/neb_capture.h` using only Apple SDK frameworks. Minimum deployment target is macOS 14.0. It is a synchronous worker boundary around one-shot ScreenCaptureKit callbacks, Vision OCR and ImageIO JPEG. No permission request, AppleScript, shell process, filesystem capture, network, UI IPC or content log exists in the bridge.

The Rust caller owns explicit user intent, visible indicator confirmation, exact target/process launch binding, supported-app classification, privacy authorization and cancellation generation. Its mandatory guard must fail closed on unknown state. This native layer independently checks granted screen permission and exact target ID/PID/bounds/visibility before and after acquisition. It refuses own-process windows and excludes the entire own application from display filters. These filters concern Neb's own frame only; they do not prove exclusion from another app's screen share. It does not attest absence of calls, private browser content or non-focused protected fields.

Never call the bridge on the AppKit main thread. Each native metadata/image wait is bounded to 2500 ms. Only one underlying ScreenCaptureKit request may be outstanding, including after a timeout. Late completion cannot invoke a caller callback or touch borrowed caller context. Apple does not expose cancellation of an in-progress screenshot; abandoned results release without pixel processing. If an OS callback never arrives, subsequent requests remain busy rather than accumulating capture work.

Raw BGRA and encoded output are passed only to synchronous Rust callbacks. Copy into zeroizing Rust memory before returning, and never retain native pointers. Wipe caller-owned OCR/JPEG input in Rust. Native mutable buffers use `memset_s`; JSON Data and JPEG sink are bounded and wiped. Apple framework internal surfaces, recognition strings and objects cannot be explicitly erased. OCR returns conservative whole-line boxes in top-left pixel coordinates so the shared redactor can cover all matching line pixels. The Rust pipeline must revalidate permission, target, privacy and session after OCR and before encoding or network handoff.

## Build

Use the Cargo target architecture in place of `arm64` for Intel builds. Do not define `NEB_NATIVE_TESTS` in the shipped archive.

```sh
xcrun swiftc -parse-as-library -O -target arm64-apple-macosx14.0 \
  -emit-object ScreenCapture.swift -o "$OUT_DIR/neb_capture.o"
xcrun libtool -static -o "$OUT_DIR/libneb_capture.a" "$OUT_DIR/neb_capture.o"
```

Emit Cargo `rustc-link-search=native=$OUT_DIR`, `rustc-link-lib=static=neb_capture`, and a native search path for every `paths.runtimeLibraryPaths` entry from `swiftc -print-target-info -target arm64-apple-macosx14.0`. Emit `rustc-link-arg=-Wl,-rpath,/usr/lib/swift`. The Mach-O object embeds its framework and Swift autolink options; Apple's linker consumes these directly. This was verified with a C executable linked by clang against the static archive. `swift-autolink-extract` is not needed on Darwin. The used SDK frameworks are Foundation, CoreGraphics, CoreVideo, ScreenCaptureKit, Vision, ImageIO and UniformTypeIdentifiers.

## Verification boundary

Run `sh tests/verify.sh`. It compiles the native archive boundary, executes C FFI tests against generated pixels and cross-compiles the production source for Intel macOS 14.0. Tests cover invalid/null/truncated/oversized input, main-thread rejection, guard refusal before permission or discovery, native completion abandonment, JSON output callback, JPEG channel order through an independent ImageIO decoder, and real Vision OCR of a generated white buffer. No test queries screen permission, enumerates windows, requests capture, captures third-party pixels or prompts for access. The isolated test export is compiled only under `NEB_NATIVE_TESTS`.

The synthetic suite passed on the host outside the tool sandbox. Inside the sandbox Vision's graphics allocator failed; this is an execution-environment limitation, not evidence that OCR succeeded there. Both arm64 and x86_64 macOS 14.0 production compilation passed against installed Swift 6.4.2 and the macOS 27.2 SDK. Actual packaged ScreenCaptureKit permission, revocation, target movement/topology, indicator timing, OS callback races, multiple scale factors and own-overlay exclusion remain controlled interactive verification work. Production availability must remain bounded by the consuming privacy gate until that work is complete.
