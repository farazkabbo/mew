//! Native macOS adapters. Pure feature state machines stay in the shared screen modules.
pub(crate) mod actions;
pub mod app_policy;
pub mod browser_mode;
pub mod call_signals;
pub mod capture;
pub mod drawing;
pub mod indicator;
pub mod input;
pub mod island;
pub mod media;
pub mod media_pins;
pub mod overlay;
mod panel;
pub mod pipeline;
pub mod privacy;
pub mod runtime;
pub mod settings;
pub mod target;
