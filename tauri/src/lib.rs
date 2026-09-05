//! Revery Exif — core logic, testable without a running Tauri app.
//!
//! The Tauri command layer in `main.rs` is wiring only; everything that can be
//! got wrong lives here so `cargo test` can reach it.

pub mod catalogue;
pub mod exiftool;
pub mod gpx;
pub mod library;
pub mod thumbcache;
pub mod undo;
pub mod write;
