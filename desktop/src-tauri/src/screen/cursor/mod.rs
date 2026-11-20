//! Neb's cursor modes (docs/CURSOR_MODES.md): DO IT, SHOW ME and CATCH ME.
//!
//! Pure logic lives here and builds and tests on every OS; what touches Windows is in
//! `screen/win/` (the mouse hook, UI Automation targets, the cursor layer) and the runtime glue
//! in `screen/cursor_run.rs`.
//!
//! - `euro`, `stream`: the 120 Hz filtered input stream (A).
//! - `target`: what can be clicked, and the planning summary (B).
//! - `predict`, `posterior`: endpoint prediction, intent, the intervention trigger (C).
//! - `scene`: what the cursor layer draws (D).
//! - `engine`: the per-frame pipeline every mode runs.
//! - `settings`: the local settings (I).

pub mod engine;
pub mod euro;
pub mod posterior;
pub mod predict;
pub mod scene;
pub mod settings;
pub mod stream;
pub mod target;
pub mod trace;
