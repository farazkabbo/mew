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
- [x] Media/browser/source/artwork coverage, settings/tray/tour and complete API/permission reconciliation.
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

The native Mac adapters intentionally refuse unsupported/private/ambiguous producer states. Safari/Firefox/Edge do not inherit Chrome/Brave's positive browser-mode proof. Display capture masks unrelated contexts. The known-call detector is limited, artwork/source metadata may be absent, and provider-dependent flows require configured services. These boundaries are preserved rather than bypassed to make a test pass.

Supplemental cursor tuning: the optimized pure-source harness passed all 28 tests including `threshold_sweep` (24 parameter combinations). This does not replace the full native Cargo suite above. The redundant unoptimized tuning run was stopped once the optimized run was underway.
