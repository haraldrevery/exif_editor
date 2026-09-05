//! Shared preconditions for the integration suites.
//!
//! # Why this exists
//!
//! Every one of these suites used to guard itself with
//!
//! ```ignore
//! macro_rules! session_or_skip {
//!     () => { match session() { Some(s) => s, None => return } };
//! }
//! ```
//!
//! and a Rust test that returns has **passed**. With `test/fixtures/` moved
//! aside, 79 of the 80 integration tests reported `ok` in 0.00s having
//! asserted nothing — including the whole write-path integrity suite, which is
//! the only thing standing between this app and a damaged photo library. A
//! fresh clone, a CI job that forgot the vendor step, or a fixture-generation
//! failure all produced a green run.
//!
//! The mistake was treating two very different absences as one:
//!
//! * **Fixtures are committed to git.** If `test/fixtures/north_gps.jpg` is
//!   missing, the checkout is broken and the run must fail. There is nothing
//!   to skip for.
//! * **The vendor tree is not committed** — `.gitignore` excludes ~56 MB of
//!   ExifTool, restored by `build_tools/fetch_exiftool.py`. A fresh clone
//!   legitimately has no engine, and failing there would tell a new
//!   contributor nothing they can act on.
//!
//! So fixtures panic and the engine skips — except under
//! `REVERY_EXIF_REQUIRE_ENGINE`, which turns the skip into a failure. CI sets
//! it after vendoring, so the one environment that must never skip cannot.

// Each integration suite compiles this module into its own crate and uses a
// different subset of it, so anything unused *there* is not unused here.
#![allow(dead_code)]

use std::path::PathBuf;

use revery_exif_core::exiftool::ExifToolSession;

/// Set this in CI, after `npm run vendor`, to make a missing engine fatal.
pub const REQUIRE_ENGINE_VAR: &str = "REVERY_EXIF_REQUIRE_ENGINE";

pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("tauri/ has a parent")
        .to_path_buf()
}

pub fn fixture_dir() -> PathBuf {
    repo_root().join("test/fixtures")
}

/// Fails the run when a committed fixture is absent.
///
/// Not a skip: these files are in git, they are what the metadata-integrity
/// assertions are written against, and a suite that cannot see them is not
/// passing — it is not running.
pub fn require_fixture(name: &str) -> PathBuf {
    let path = fixture_dir().join(name);
    assert!(
        path.is_file(),
        "fixture {name} is missing from {}.\n\
         These are committed to git, so this checkout is incomplete rather \
         than merely unvendored. Restore them with:\n\
         \x20   python3 build_tools/make_fixtures.py",
        fixture_dir().display()
    );
    path
}

/// The vendored engine, or `None` with a loud note when it has not been fetched.
///
/// Returns `None` only when skipping is legitimate. With
/// `REVERY_EXIF_REQUIRE_ENGINE` set it panics instead, so a build that is
/// supposed to have vendored cannot quietly test nothing.
pub fn engine() -> Option<ExifToolSession> {
    match ExifToolSession::locate(&repo_root()) {
        Ok(exe) => Some(ExifToolSession::new(exe)),
        Err(why) => {
            if std::env::var_os(REQUIRE_ENGINE_VAR).is_some() {
                panic!(
                    "{REQUIRE_ENGINE_VAR} is set, so a missing engine is a failure: {why}\n\
                     Run `python3 build_tools/fetch_exiftool.py --all`."
                );
            }
            eprintln!(
                "SKIPPING (no vendored ExifTool): {why}\n\
                 Run `python3 build_tools/fetch_exiftool.py --all` to exercise this suite, \
                 or set {REQUIRE_ENGINE_VAR}=1 to make this a failure."
            );
            None
        }
    }
}
