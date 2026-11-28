# Completing Windows feature parity on Mac

Integration base: `e83482d`, branch `feature/macbook`, including `origin/main` through `7f4d9fe`. Owner authorization: implement every Windows desktop feature in the same shared app, automate tests, run code/security review, then commit verified work. Manual Mac acceptance follows. No placeholder, compiled-but-unused adapter or intentionally unavailable handler counts as implemented.

## Execution and verification checklist

- [x] Production capture session: explicit intent, exact foreground/window binding, owned presented indicator, privacy/call policy, full redaction, cancellation, local pixel geometry, window and monitor scope.
- [x] Existing account reused for bounded authenticated transport; streamed replies, errors, token revocation and cross-origin/cancellation refusal.
- [x] Native Ask, voice start/commit/cancel, intent routing, pause and the Mac gesture equivalents; activity/tray/settings/onboarding.
- [x] Tutor ink rendering, reanchor, bounded acknowledgement, content-change fading and scrolling.
- [x] Circle & Ask selection/shapes, typed/read/spoken question, streamed steps, playback controls/follow-ups, save/destination/recall.
- [x] Memory-only clip preview, authorized image protocol, crop/blackouts/expiry, explicit save, notebook entry/readback.
- [x] Notes Check, walkthrough/skills/recheck, screen quizzes/reviews and Watch/help modes.
- [x] Hand/typing, public native target/action adapters, user approval and actual execution limits/cancellation.
- [x] SHOW ME, DO IT's four chores/replay/undo and CATCH ME's five rules with consent/local state.
- [x] Handoff behind its existing flag: protected local timeline, preview/redaction/Send, receiver/deep links and safe Pick up.
- [ ] Exact browser/player support equivalence: inspected Chrome/Brave, paired Chromium/Firefox companion profiles and native Spotify/Music/TV/VLC/QuickTime adapters exist; Safari native transport and generic system-wide media remain explicit platform gaps.
- [x] Whole-branch code and security review; focused regression fixes; full repository and native checks; package from exact source; commit verified result.

For each checkbox record implementing files, normal-app entry points, denial/cancellation behavior, automated evidence and review result. Runtime-only checks belong to the owner's manual acceptance list and must not hide missing implementation.

## Implementation ownership

- Capture/session and pipeline contracts: `mac_capture_session` agent.
- Native service transport/account seam: `mac_service_transport` agent.
- Notes/walkthrough/quiz/Watch orchestration: `mac_study_flows` agent.
- Main integration, Ask/voice/ink/Circle/clip and subsequent task dispatch/reviews: root.

Only root runs shared Cargo builds and changes entry-point/handler registration. Agents own separate files and use synthetic tests. No personal desktop capture, real player/clipboard automation or provider charges are required for automated gates. Never weaken fail-closed behavior to make a fixture pass.

## Binding decisions

The owner approved the Windows-equivalent limited call/recorder detector policy on Mac; `KnownSignalsIdle` must never be described as universal absence of calls or sharing. Unknown/private browser identity remains a refusal. Capturing and delivering results must independently revalidate session/account/target/permission changes. Shared protocol helpers remain the source of truth across both OS implementations.

## Closeout evidence (2026-11-26)

The checked implementation items above mean source integration and automated verification. They do not replace the owner's manual acceptance. The per-feature file and entry-point map is [MAC_PARITY.md](MAC_PARITY.md); the ordered test cases and expected behavior are [desktop/MAC_TESTING.md](../desktop/MAC_TESTING.md).

- Full repository gate: `UV_CACHE_DIR=/tmp/mew-uv-cache pnpm check` passed formatting, lint, type checks and 2,169 tests: shared 513, ink 194, desktop Vitest 46, desktop Node 23, frontend 800, Supabase 183 and backend 410.
- Native gate: `MACOSX_DEPLOYMENT_TARGET=14.0 cargo test --locked --offline` passed 487 tests. The loopback-only auth test was also run explicitly with `--ignored` and passed. The separate slow `threshold_sweep` tuning benchmark is ignored by the normal suite. It was additionally run in an optimized temporary harness using the eight unchanged pure cursor source modules and the exact `ScreenRect` definition; see the supplemental result below. This is a tuning exercise, not real mouse/trackpad acceptance.
- Desktop overlay integration: `E2E_BASE_URL=http://localhost:3100 E2E_API_PORT=8100 E2E_CHANNEL=chrome pnpm --filter @mew/frontend e2e desktop-overlays.spec.ts` passed 27 browser tests with fake IPC, including Mac captions and Command shortcuts.
- Strict native lint: `cargo clippy --locked --offline --all-targets -- -D warnings` passed.
- `sh desktop/src-tauri/native/macos/tests/verify.sh` passed synthetic Swift/C FFI, JPEG decode, Vision OCR and Intel bridge cross-compilation. No personal screen was captured.
- Packaging: `tauri build --debug --bundles app --config src-tauri/tauri.macos.conf.json` produced `desktop/src-tauri/target/debug/bundle/macos/Neb.app`. The bundle received an ad-hoc development signature with the existing entitlements, and `codesign --verify --strict` passed.
- Secret scan: `pnpm scan:secrets` passed for shipped source/browser assets. A deliberate key-shaped test fixture is assembled from fake parts so real literal-key detection remains enabled.
- Independent correctness and security reviews drove the fixes recorded in the parity ledger. Final read-only remediation reviews found no remaining actionable defects in the reviewed paths. These were source reviews, not real provider or OS acceptance.

### Owner acceptance and release gates

Run the manual guide on the final development app. Physical shortcuts, recording/Accessibility/Automation/microphone permissions, native actions, real accounts/providers, media layouts, Spaces/displays and OS window behavior still need that pass. Windows-native runtime and signed production updates require their own platform/release checks. A local ad-hoc signed debug app is not a Developer ID signed, notarized download release.

The native Mac adapters intentionally refuse unsupported/private/ambiguous producer states. Safari remains unavailable. Firefox and Edge require their own approved companion profile and fresh native window proof; they never inherit Chrome/Brave's Automation proof. Display capture masks unrelated contexts. The known-call detector is limited, artwork/source metadata may be absent, and provider-dependent flows require configured services. These boundaries are preserved rather than bypassed to make a test pass.

Supplemental cursor tuning: the optimized pure-source harness passed all 28 tests including `threshold_sweep` (24 parameter combinations). This does not replace the full native Cargo suite above. The redundant unoptimized tuning run was stopped once the optimized run was underway.

## Follow-up verification (2026-11-27)

The individual-behavior comparison found additional omissions after the original feature-family audit. They are listed, with their implementation owners, in the follow-up section of `MAC_PARITY.md`. Checked feature families above must not be read as an exhaustive claim about every supported application/browser. Generic system-wide media and wider browser privacy/source support remain open code boundaries.

New review fixes bind displayed controls, deferred native work, capture/session replacement, renderer ACKs, save/append/preview preparation and queued UI events to their originating session and account. Repository discovery checks the final canonical ancestor against the home boundary, and saved video moments require matching captured and current source identity. Final verification results are recorded below after the frozen-source checks.

Frozen-source follow-up results:

- Full repository gate passed formatting, lint, type checks and **2,172 tests** (shared 513, ink 194, desktop Vitest 46, desktop Node 26, frontend 800, Supabase 183, backend 410).
- Native suite passed **518 tests**, with 0 failures and 2 default-ignored tests. The loopback auth test was separately run with `--ignored` and passed. The unchanged optional cursor tuning benchmark remains covered by the earlier recorded pure-source run.
- Overlay integration passed **28 browser tests**, including Mac Command shortcuts and displayed action-session echo; existing Windows IPC expectations stayed unchanged.
- Strict Clippy across all native targets/tests, changed-source Rust formatting, Prettier and shipped-source secret scanning passed.
- Synthetic Swift/C FFI, JPEG/Vision and Intel capture-bridge compilation passed without personal screen capture.
- Code/security reviews covered deferred action/session ownership, streaming partial failure, source attribution, saved-entry transforms, local IPC boundaries and bounded Handoff/Git metadata. The final owned-retention integration was reviewed locally and regression-tested: ordinary frame expiry stays strict; explicit weak grants do not outlive their native owner or authorize new capture.

No real user desktop input/capture, provider calls, production account actions, signing identities or notarization were used for these automated gates. Known browser/player support gaps in the ledger remain open; this record must not be described as exact Windows support equivalence.

- Final Apple Silicon development bundle rebuilt successfully at `desktop/src-tauri/target/debug/bundle/macos/Neb.app`; existing entitlements applied with an ad-hoc signature, and `codesign --verify --strict` passed. This is a local development artifact, not a notarized public installer.

### Browser companion continuation

The extension, native helper, explicit local installation/pairing controls and native-window
binding have been added to this branch. The new [companion guide](MAC_BROWSER_COMPANION.md)
explains the separate browser installation requirement and the pending Safari, artwork and
website skip-control work. Earlier verification totals above describe earlier commits; use
the latest final verification record for this continuation. Do not read the new companion
source as proof of actual browser installation, OS behavior or production extension signing.

### Verified companion checkpoint (2026-11-28)

- Refreshed `origin/main`: `7f4d9fe`, already included in this branch.
- `pnpm check`: formatting, lint (including shipped companion scripts), type checks and
  **2,209 tests passed**: shared 513, ink 194, desktop Vitest 46, desktop Node 39,
  companion Node 24, frontend 800, Supabase 183 and backend 410. Backend multiprocessing
  needs local IPC permission in the test environment.
- Native Rust: **539 app tests and 9 helper tests passed**, with two app tests intentionally
  ignored by default. The existing loopback-only authentication test was separately run and
  passed. Strict Clippy passed for all targets.
- Desktop overlay integration: **28 tests passed** with fake IPC, including browser profile
  approval and installation controls, safe publisher text and existing Windows/Mac behavior.
- Swift/C capture bridge synthetic checks passed without screen capture. The checked-in
  `native/macos/tests/verify_browser_auth.sh` smoke test accepted the exact signed sibling
  app and rejected a signed impostor using real Mac peer credentials. It also refused an
  unrecognized parent as a browser. Actual approved-browser parent authentication remains a
  manual installation check.
- Chromium, Firefox and Safari source bundles built. The Safari bundle is source only; the
  signed native containing extension and its transport are not implemented.
- Apple Silicon debug `Neb.app` built with the embedded `neb-browser-host`. Development
  signatures were verified. This is an ad-hoc signed development app, not a notarized release.
- Secret scan and whitespace checks passed. No actual browser registration, personal tab or
  screen reading, native desktop input, provider calls or production account actions occurred.

The earlier scoped agent reviews found and resolved the pending-play source-identity race.
The subsequent integration review added a shared deadline for fragmented frames, refused
nearly coincident native windows under rounding tolerance, and required a live native media
owner immediately before dispatching queued controls. Profile revocation, replaced connections,
changed document/player identities and missing permissions continue to fail closed.

This checkpoint does **not** establish exact Windows support equivalence. Safari native
integration, generic website skip handlers/artwork, cross-origin embedded players and a generic
system-wide Mac media-session adapter remain outside the implemented support set. Production
signing/notarization also awaits the owner's Apple Developer team. Manual OS acceptance is
still required for the implemented adapters.
