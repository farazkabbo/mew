# Cursor modes: DO IT, SHOW ME, CATCH ME (plan, step 0)

Status: plan only, waiting for the owner. No code yet. Numbers to be filled in as milestones land.

## Our stack (what recon found)
- **Desktop:** Tauri 2, Rust (`desktop/src-tauri`), `windows` 0.62 crate, PerMonitorV2 manifest.
  Overlays are bundled WebView pages (`shell/`, `overlay-src/`) or native windows (`win/indicator.rs`).
  **No sidecar is needed:** Rust already calls Win32, UIA, WinRT OCR and touch injection directly.
- **There is no `/api/ask`.** The desktop calls `/api/screen/*` device routes (token in Credential
  Manager, `win/http.rs`, `device_call.rs`) through `server/question-gate.ts`.
- **Hotkeys:** `keys.rs` + `hold.rs` poll left Ctrl+Alt (no keyboard hook: decisions 9, 11).
- **Existing pieces to reuse:** `win/uia.rs` (focus, password field, address bar), `win/ocr.rs`,
  `win/winevent.rs` (WinEvent hooks + a temporary `WH_MOUSE_LL`), `win/target.rs` (foreground
  window, monitor DPI), `pointer.rs` (cursor follower), `win/launch.rs` (open app/URL safely),
  `privacy/` (password fields, private windows, blocklist), `config.rs` (local-only settings).
- **Overlap:** coach mode (S4, server-planned walkthrough) and Neb's hand `show`/`do` (decisions
  17–18, `screen_hand.rs`) already cover parts of SHOW ME and DO IT. See the open questions.
- **Notebooks** are server-side; the desktop saves via `/api/screen/clips` + `destination.rs`.
- **Speech:** the main WebView speaks replies (ElevenLabs token from the server).

## Where each piece plugs in (new code in `src/screen/cursor/`)
Pure modules build and test on every OS; Win32 parts live in `src/screen/win/` as today.
| Piece | Pure (testable) | Windows side |
|---|---|---|
| A. Input stream | `cursor/euro.rs` (One Euro), `resample.rs` (120 Hz, vel/acc) | `win/mouse_stream.rs`: `WH_MOUSE_LL` on its own thread, pushes into a ring buffer only |
| B. Targets | `cursor/target.rs` (Target, summary ≤40, content filter) | `win/uia_targets.rs`: cache per HWND, refreshed on StructureChanged/FocusChanged; OCR fallback |
| C. Prediction | `predict.rs` (min-jerk fit, `EndpointModel` trait), `posterior.rs`, `trigger.rs` | none |
| D. Overlay | `overlay_plan.rs` (path curve, glow/expand scale) | `win/cursor_layer.rs`: native Direct2D + DirectComposition window per monitor (new `windows` features only, no crate) |
| E. Paths | `path.rs` (anchors, fuzzy resolve), `mastery.rs` (fading) | local cache file next to `screen-coach.json` |
| F. DO IT | `doit/allowlist.rs`, `rename_plan.rs`, `undo_log.rs`, `recipe_ld.rs` | `win/search_index.rs` (ISearchQueryHelper + OLE DB), `ms-settings:` via `launch.rs` |
| G. CATCH ME | `rules/{reply_all,attach,unsaved,delete,terminal}.rs`, `rate.rs` | UIA watchers; no network module linked |
| H. Voice | correction-word table per language | the page caches pre-generated clips in IndexedDB |
| I. Settings | `config.rs` gains a `cursor` section | local settings page (decision 1), tray pause |
Server: `POST /api/screen/plan` (device token, `startQuestion` → spends one question; schema in
`packages/shared/src/screen-plan.ts`; Gemini returns semantic steps validated in Rust).

## Native notes
- The hook callback only copies `{x, y, t}` into a lock-free buffer (LL hooks are silently removed
  if slow). Coordinates are physical virtual-desktop px (PMv2), so negative-origin monitors work.
- The stream runs only while a mode is active; CATCH ME idles on UIA events and arms the
  predictor only when a risky target exists in the foreground window.
- Terminal rule without a keyboard hook: read the prompt line via UIA TextPattern on
  text-changed events while a terminal is focused, and speak up before Enter. VS Code's
  terminal exposes text only with its accessibility support on; checked at run time.
- Planning payload filter: control names only for Button/MenuItem/TabItem/Hyperlink/CheckBox/
  ComboBox/ListItem-in-nav; drop Edit/Document/DataItem names (they hold user content).
- `save_recipe` reads the page URL from the address bar (`uia::address_bar`), fetches the HTML
  on the device (https only, 2 MB cap, no cookies) and parses JSON-LD with `serde_json`.

## Milestones (one at a time, report after each)
M1 stream + filter + UIA targets + cursor layer + debug view · M2 predictor, posterior, trigger,
trace recorder + replay harness · M3 SHOW ME · M4 DO IT · M5 CATCH ME · M6 settings, consent v6,
telemetry counts, polish.

## Test plan
- `cargo test` (pure modules) + Vitest for the route/schema. CI is Ubuntu and doesn't build the
  desktop, so Rust tests run locally (as today); pure modules are kept OS-free so they could.
- Traces: `tests/traces/*.json`. Synthetic set (min-jerk + Fitts timing + noise + corrective
  submovements, mouse and touchpad profiles) to start; **real numbers need the owner's recorded
  traces** (debug view has a "record" switch, local file only).
- Predictor: error at 50/75/90%, correct-target rate motion-only vs with prior. False
  interventions on right-target traces < 2% (tune thresholds in config).
- Paths: fixture trees at DPI 100/150/200, light/dark, renamed AutomationId → Name fallback.
- DO IT: rename undo byte-exact (temp dir); uncertain find → confirm; JSON-LD → zero AI calls
  (mock client counts calls).
- CATCH ME: positive/negative fixture per rule; log entries are `{rule, app, ts, outcome}` only.
- Perf: per-frame timing in the debug view and a bench test; idle CPU sampled with only CATCH ME on.
- Safety: a test greps `src/` and fails if `SendInput`, `SetCursorPos`, `mouse_event` or
  `InjectTouchInput` appear outside `win/mouse.rs`, `win/typing.rs` (Neb's hand and typing,
  decisions 15–17) and `doit/`, and that DO IT dispatches only `allowlist.rs` actions.

## Decisions (owner, 2026-11-20: "use what is best and build everything"; binding)
1. **SHOW ME takes "show me how" and "where is…"** when the window in front has UI Automation
   targets; Neb's hand `show` stays the fallback (screenshot), coach mode stays for study tasks.
2. **Reading Windows Settings' control names is allowed** (local, names only, no screenshot);
   decision 5 still blocks capturing it. `open_setting` only launches `ms-settings:` URIs.
3. **A SHOW ME or DO IT plan spends one question**; re-plans in the same lesson are free
   follow-ups (`startQuestion` groups). Replays, fading, cached paths and CATCH ME are free.
4. **The input check** allows `SendInput`/`InjectTouchInput` only in `win/mouse.rs`,
   `win/typing.rs` (Neb's hand and typing, decisions 15–17); DO IT's v1 actions need none.
5. **CATCH ME has its own consent** (`CATCH_ME_CONSENT`), not a bump of Screen Coach's
   `CONSENT_VERSION` (which would switch Screen Coach off for everyone).
6. **No keyboard hook**: the terminal rule reads the prompt line through UI Automation.
7. **Commits**: one per milestone on `feat/cursor-modes`, no attribution lines.
8. **save_recipe** saves through the existing clips route (the page's picture plus the recipe as
   its text) into a "Recipe Book" notebook it creates if missing; no new storage.
