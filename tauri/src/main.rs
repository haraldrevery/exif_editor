//! Revery Exif — Tauri v2 backend.
//!
//! Wiring only. Everything with logic worth testing lives in `lib.rs`
//! (`exiftool.rs`, `library.rs`) so `cargo test` can reach it without a
//! running app.
//!
//! Security model, mirroring Revery Notebook:
//!   * One open folder at a time, held in `LibraryRoot`.
//!   * Every path argument is canonicalised and confirmed to sit inside that
//!     root before anything touches it (`library::resolve_within`).
//!   * The frontend never sees `window.__TAURI__`; it calls `window.NativeAPI`.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::Mutex;

use revery_exif_core::catalogue::{self, TagInfo};
use revery_exif_core::exiftool::ExifToolSession;
use revery_exif_core::gpx;
use revery_exif_core::library::{self, PhotoEntry, Preview};
use revery_exif_core::thumbcache;
use revery_exif_core::undo;
use revery_exif_core::write::{self, BatchOutcome, PhotoEdit};
use tauri::{Manager, State};

/// The folder the user has open. `None` until they pick one — with no root
/// set, every path-taking command refuses, so a command cannot be reached
/// before the user has granted access to somewhere.
#[derive(Default)]
struct LibraryRoot(Mutex<Option<PathBuf>>);

impl LibraryRoot {
    fn get(&self) -> Result<PathBuf, String> {
        self.0
            .lock()
            .map_err(|_| "Library root lock poisoned".to_string())?
            .clone()
            .ok_or_else(|| "No folder is open".to_string())
    }
}

struct Engine(ExifToolSession);

/// The writable-tag list, built on first use.
///
/// Roughly three seconds of ExifTool and two megabytes of XML, so it is not
/// built at launch — nobody should wait for the tag picker on a run where they
/// never open it. A `Mutex<Option<_>>` rather than a `OnceLock` because the
/// query can fail (a broken vendor tree), and a failure should be retried on
/// the next click rather than cached forever.
#[derive(Default)]
struct TagCatalogue(Mutex<Option<Vec<TagInfo>>>);

/// Photos holding changes the user has not written yet.
///
/// Those drafts live in the renderer's memory and nowhere else — nothing
/// touches a file until Apply runs — so the close handler has no way to work
/// this out for itself. The renderer reports it whenever the badges change,
/// and this is where the answer waits.
#[derive(Default)]
struct DirtyDrafts(Mutex<usize>);

/* ══════════════════════════════════════════════════════════════════════════
   COMMANDS

   # Why most of these say `#[tauri::command(async)]`

   A command without it is `ExecutionContext::Blocking`: the generated wrapper
   calls the function inline, on the thread the IPC message arrived on, which
   is the webview's — the UI thread. Everything below that touches ExifTool or
   walks the filesystem therefore froze the window for as long as it ran. A
   two-hundred-file batch is minutes of an unresponsive window, with the OS
   offering to kill the app *while it is replacing photographs*; `writable_tags`
   is three seconds on the first click of the tag picker.

   `(async)` on a synchronous function moves the call onto Tauri's async
   runtime instead. The function is unchanged — no signature, no `.await` — so
   this is a scheduling change and nothing else.

   **It is only safe because `write::MUTATION_LOCK` exists.** Running these
   concurrently means two batches can reach the write path at once, and they
   share one undo store whose `begin` starts by deleting it — see the comment
   on that lock, and the two tests in `tests/write_path.rs` that fail without
   it. Serialisation used to be a side effect of running on one thread; it is
   now stated where it can be relied on.

   The commands that stay blocking do so because they are genuinely trivial:
   a lock and a copy (`set_dirty`), an `eprintln!` (`report_renderer`), one
   `is_file` (`undo_available`), reading argv (`initial_folder`).
══════════════════════════════════════════════════════════════════════════ */

/// Opens a folder and returns its photos. This is what grants access to a
/// location; every later command is confined to what is set here.
#[tauri::command(async)]
fn open_library(
    path: String,
    app: tauri::AppHandle,
    root: State<'_, LibraryRoot>,
) -> Result<Vec<PhotoEntry>, String> {
    // `library::canonical`, not `Path::canonicalize`: this path is the root every
    // later path is derived from and compared against, and on Windows the raw
    // canonical form carries a `\\?\` prefix that ExifTool cannot open.
    let resolved = library::canonical(std::path::Path::new(&path))
        .map_err(|e| format!("Cannot open {path}: {e}"))?;
    if !resolved.is_dir() {
        return Err(format!("Not a folder: {path}"));
    }
    // Clear up after a crash mid-write before listing. The originals are
    // intact — a crash leaves the staged temp, never a damaged photo — but the
    // strays would otherwise pile up in the user's folder unnoticed.
    let swept = write::sweep_stale_temps(&resolved);
    if swept > 0 {
        eprintln!("Removed {swept} unfinished edit file(s) from a previous session");
    }
    // Undo is a within-session promise. After a restart the snapshots are just
    // hidden files taking up space, and offering an "undo" that reaches back
    // into a previous session would be a surprising thing to hand someone.
    if undo::sweep(&resolved) {
        eprintln!("Discarded an undo store from a previous session");
    }
    // Unlike the two above, this one is *not* about this folder — it bounds the
    // app-wide thumbnail cache. Here because opening a folder is the moment the
    // app is already going to the filesystem and is not yet drawing anything.
    let dropped = thumbcache::sweep();
    if dropped > 0 {
        eprintln!("Dropped {dropped} cached thumbnail(s) to stay within budget");
    }

    let entries = library::scan_folder(&resolved)?;

    // Let the webview load images from this folder over asset:. The config
    // scope is empty on purpose — access is granted here, at the moment the
    // user picks a folder, and extends no further than what they picked.
    // Non-recursive, matching the non-recursive scan.
    app.asset_protocol_scope()
        .allow_directory(&resolved, false)
        .map_err(|e| format!("Cannot grant image access to the folder: {e}"))?;

    *root
        .0
        .lock()
        .map_err(|_| "Library root lock poisoned".to_string())? = Some(resolved);
    Ok(entries)
}

/// Re-scans the open folder, for the refresh button.
#[tauri::command(async)]
fn rescan_library(root: State<'_, LibraryRoot>) -> Result<Vec<PhotoEntry>, String> {
    library::scan_folder(&root.get()?)
}

/// Reads the full tag set for the given files.
///
/// Batched deliberately: one ExifTool round trip for a whole selection rather
/// than one per file.
#[tauri::command(async)]
fn read_metadata(
    paths: Vec<String>,
    root: State<'_, LibraryRoot>,
    engine: State<'_, Engine>,
) -> Result<serde_json::Value, String> {
    let root = root.get()?;
    let resolved = paths
        .iter()
        .map(|p| library::resolve_within(&root, p))
        .collect::<Result<Vec<_>, _>>()?;
    library::read_metadata(&engine.0, &resolved)
}

/// Reads a named handful of tags for the given files.
///
/// What the CSV export uses. `read_metadata` returns everything, which is
/// right for one selection and wrong for a whole folder — see
/// `library::read_fields` for the size arithmetic.
#[tauri::command(async)]
fn read_fields(
    paths: Vec<String>,
    tags: Vec<String>,
    root: State<'_, LibraryRoot>,
    engine: State<'_, Engine>,
) -> Result<serde_json::Value, String> {
    let root = root.get()?;
    let resolved = paths
        .iter()
        .map(|p| library::resolve_within(&root, p))
        .collect::<Result<Vec<_>, _>>()?;
    library::read_fields(&engine.0, &resolved, &tags)
}

/// Extracts an embedded preview for a file the webview cannot decode.
///
/// Returns `None` for the rare file that has no preview at all; the grid shows
/// a placeholder rather than treating that as a failure.
#[tauri::command(async)]
fn read_preview(
    path: String,
    root: State<'_, LibraryRoot>,
    engine: State<'_, Engine>,
) -> Result<Option<Preview>, String> {
    let resolved = library::resolve_within(&root.get()?, &path)?;
    library::extract_preview(&engine.0, &resolved)
}

/// Reads one whole file into the webview, for the HEIC decoder.
///
/// Confined to the open folder by the same guard as everything else, and
/// capped — see `library::read_file_bytes` for why the frontend cannot just
/// fetch the file itself in either shell.
#[tauri::command(async)]
fn read_file_bytes(path: String, root: State<'_, LibraryRoot>) -> Result<String, String> {
    library::read_file_bytes(&root.get()?, &path)
}

/// A previously computed thumbnail for `path`, if one is still valid.
///
/// Confined to the open folder like every other path-taking command, so this
/// cannot be used to ask whether an arbitrary file exists.
#[tauri::command(async)]
fn read_thumb_cache(
    path: String,
    edge: u32,
    root: State<'_, LibraryRoot>,
) -> Result<Option<String>, String> {
    let resolved = library::resolve_within(&root.get()?, &path)?;
    thumbcache::read(&resolved, edge)
}

/// Stores a thumbnail the renderer decoded, for the next launch.
///
/// The renderer computes these because the decoder is WebAssembly running in a
/// worker — linking libheif into the core would put a C++ dependency where
/// there is currently none. So the bytes come *back* across the boundary, and
/// `thumbcache::write` is where they are checked before they reach the disk.
#[tauri::command(async)]
fn write_thumb_cache(
    path: String,
    edge: u32,
    base64: String,
    root: State<'_, LibraryRoot>,
) -> Result<(), String> {
    let resolved = library::resolve_within(&root.get()?, &path)?;
    thumbcache::write(&resolved, edge, &base64)
}

/// Every tag the bundled ExifTool will write, for the All tab's tag picker.
///
/// Built once per session and cached. Called on the first "Add tag…" click
/// rather than at startup, because it costs seconds and most sessions never
/// need it.
#[tauri::command(async)]
fn writable_tags(
    engine: State<'_, Engine>,
    cache: State<'_, TagCatalogue>,
) -> Result<Vec<TagInfo>, String> {
    let mut guard = cache
        .0
        .lock()
        .map_err(|_| "Tag catalogue lock poisoned".to_string())?;
    if guard.is_none() {
        *guard = Some(catalogue::writable_tags(&engine.0)?);
    }
    Ok(guard.as_ref().expect("just populated").clone())
}

/// Reports the engine version, so the UI can show what is actually running and
/// surface a missing-vendor-tree failure at startup rather than on first use.
#[tauri::command(async)]
fn engine_version(engine: State<'_, Engine>) -> Result<String, String> {
    let response = engine.0.execute(&["-ver".into()])?;
    Ok(response.stdout.trim().to_string())
}

/// Applies one edit across a selection, atomically and verified per file.
///
/// Every file is pre-flighted before any is written, and the result carries a
/// per-file outcome — a batch where three of fifty fail is neither a success
/// nor a failure, and the caller has to be able to say which three.
#[tauri::command(async)]
fn apply_edit(
    paths: Vec<String>,
    edit: PhotoEdit,
    root: State<'_, LibraryRoot>,
    engine: State<'_, Engine>,
) -> Result<BatchOutcome, String> {
    write::apply_batch(&engine.0, &root.get()?, &paths, &edit)
}

/// Writes a different edit to each of several files, in one batch.
///
/// Drafts are held per photo, so a selection can carry different changes for
/// different files. That has to land as **one** call: `undo::UndoBatch::begin`
/// clears the previous batch, so applying in several would leave only the last
/// one undoable — five photos edited, two restorable.
///
/// `write::apply_per_file` is the same pre-flight-then-write machinery
/// `apply_edit` uses, differing only in taking an edit per file. `apply_geotag`
/// has been going through it since Phase 4.
#[tauri::command(async)]
fn apply_edits(
    edits: Vec<(String, PhotoEdit)>,
    root: State<'_, LibraryRoot>,
    engine: State<'_, Engine>,
) -> Result<BatchOutcome, String> {
    write::apply_per_file(&engine.0, &root.get()?, &edits)
}

/// Picks a GPX track file.
///
/// Separate from the folder picker because the track is *read-only input* from
/// anywhere on disk — it is not part of the photo library and is never written
/// to, so it deliberately does not go through the library-root guard.
#[tauri::command]
async fn choose_gpx_file(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .add_filter("GPS track", &["gpx", "GPX"])
        .pick_file(move |picked| {
            let _ = tx.send(picked.map(|p| p.to_string()));
        });
    rx.recv().ok().flatten()
}

/// Writes a CSV the renderer built, to a file the user picks here.
///
/// **The renderer never names the destination.** Every other path-taking
/// command is confined to the open folder by `library::resolve_within`, and an
/// export is by definition outside it — so rather than punching a
/// renderer-controlled write through that guard, the command opens the dialog
/// itself and writes to whatever came back. The only path that reaches the
/// filesystem is one the user chose a moment ago in a native dialog.
///
/// The same reasoning as `choose_gpx_file`, in the other direction: that one
/// reads from anywhere, this one writes to one place, and neither is part of
/// the photo library.
///
/// Returns the path written, or `None` when the dialog was dismissed.
#[tauri::command]
async fn export_csv(
    csv: String,
    suggested_name: Option<String>,
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    let mut builder = app.dialog().file().add_filter("CSV", &["csv"]);
    if let Some(name) = suggested_name {
        builder = builder.set_file_name(name);
    }
    builder.save_file(move |picked| {
        let _ = tx.send(picked.map(|p| p.to_string()));
    });
    let Some(path) = rx
        .recv()
        .map_err(|_| "The save dialog closed unexpectedly.".to_string())?
    else {
        return Ok(None);
    };
    // Written whole rather than streamed: the caller already holds the entire
    // string, and a partial CSV on disk is worse than no CSV at all.
    std::fs::write(&path, csv.as_bytes()).map_err(|e| format!("Could not write {path}: {e}"))?;
    Ok(Some(path))
}

/// What geotagging against `gpx_path` would do — without writing anything.
///
/// The preview and the write share this matching, so what the review shows is
/// exactly what lands. A preview produced by different code than the write is
/// a preview that eventually lies.
#[tauri::command(async)]
fn preview_geotag(
    paths: Vec<String>,
    gpx_path: String,
    offset_seconds: i64,
    max_gap_seconds: Option<i64>,
    root: State<'_, LibraryRoot>,
    engine: State<'_, Engine>,
) -> Result<gpx::GeotagPreview, String> {
    let root = root.get()?;
    // The track may live anywhere the user can reach — it is read, never
    // written, and is not part of the photo library.
    let xml = std::fs::read_to_string(&gpx_path)
        .map_err(|e| format!("Cannot read {gpx_path}: {e}"))?;
    let track = gpx::Track::parse(&xml)?;

    let resolved = paths
        .iter()
        .map(|p| library::resolve_within(&root, p))
        .collect::<Result<Vec<_>, _>>()?;
    let metadata = library::read_metadata(&engine.0, &resolved)?;
    let entries = metadata.as_array().cloned().unwrap_or_default();

    let max_gap = max_gap_seconds.unwrap_or(gpx::DEFAULT_MAX_GAP_SECS);
    let matches = gpx::match_photos(&track, &entries, offset_seconds, max_gap);
    Ok(gpx::GeotagPreview::build(&track, matches))
}

/// Writes the positions from a previewed geotag.
///
/// Takes the matches rather than re-deriving them, so what was reviewed is
/// exactly what is written. Photos that did not match are simply absent.
#[tauri::command(async)]
fn apply_geotag(
    matches: Vec<GeotagAssignment>,
    root: State<'_, LibraryRoot>,
    engine: State<'_, Engine>,
) -> Result<write::BatchOutcome, String> {
    let edits: Vec<(String, PhotoEdit)> = matches
        .into_iter()
        .map(|assignment| {
            let mut edit = PhotoEdit::default();
            edit.gps = Some(write::GpsEdit::Set {
                position: assignment.position,
            });
            (assignment.path, edit)
        })
        .collect();
    if edits.is_empty() {
        return Err("None of the selected photos matched the track.".into());
    }
    write::apply_per_file(&engine.0, &root.get()?, &edits)
}

#[derive(serde::Deserialize)]
struct GeotagAssignment {
    path: String,
    position: library::GpsPosition,
}

/// What a date shift would produce, without writing anything.
///
/// The same arithmetic the write path verifies against, so the preview cannot
/// promise a timestamp the write then fails to produce.
#[tauri::command(async)]
fn preview_date_shift(
    paths: Vec<String>,
    seconds: i64,
    root: State<'_, LibraryRoot>,
    engine: State<'_, Engine>,
) -> Result<Vec<DateShiftRow>, String> {
    let root = root.get()?;
    let resolved = paths
        .iter()
        .map(|p| library::resolve_within(&root, p))
        .collect::<Result<Vec<_>, _>>()?;
    let metadata = library::read_metadata(&engine.0, &resolved)?;

    Ok(metadata
        .as_array()
        .map(|entries| {
            entries
                .iter()
                .map(|entry| {
                    let before = entry
                        .get("EXIF:DateTimeOriginal")
                        .and_then(|v| v.as_str())
                        .map(str::to_string);
                    let after = before
                        .as_deref()
                        .and_then(gpx::parse_exif_datetime)
                        .map(|t| gpx::format_exif_datetime(t + seconds));
                    DateShiftRow {
                        path: entry
                            .get("SourceFile")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_string(),
                        before,
                        after,
                    }
                })
                .collect()
        })
        .unwrap_or_default())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DateShiftRow {
    path: String,
    /// `None` when the photo has no capture time, so nothing will be shifted.
    before: Option<String>,
    after: Option<String>,
}

/// Restores the files changed by the last batch.
#[tauri::command(async)]
fn undo_last(root: State<'_, LibraryRoot>) -> Result<undo::UndoOutcome, String> {
    undo::undo_last(&root.get()?)
}

/// Whether there is a batch waiting to be undone, for the button's state.
#[tauri::command]
fn undo_available(root: State<'_, LibraryRoot>) -> bool {
    root.get().map(|r| undo::is_available(&r)).unwrap_or(false)
}

/// Reports how many photos are holding unwritten changes.
///
/// Called on every change to the draft badges, so it is deliberately trivial:
/// the close handler reads the number, and nothing else does.
#[tauri::command]
fn set_dirty(dirty: bool, count: usize, drafts: State<'_, DirtyDrafts>) {
    if let Ok(mut guard) = drafts.0.lock() {
        *guard = if dirty { count } else { 0 };
    }
}

/// Records which map renderer the frontend was able to use.
///
/// WebGL availability under WebKitGTK varies by driver and by whether
/// accelerated compositing is enabled, so this is the first thing worth
/// knowing when someone reports a blank or slow map.
#[tauri::command]
fn report_renderer(detail: String) {
    eprintln!("[map] {detail}");
}

/// A folder passed on the command line, for "Open with" from a file manager
/// and for dropping a folder on the app icon. `None` when launched bare.
#[tauri::command]
fn initial_folder() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|arg| !arg.starts_with('-'))
        .filter(|arg| std::path::Path::new(arg).is_dir())
}

/* ══════════════════════════════════════════════════════════════════════════
   ENTRY POINT
══════════════════════════════════════════════════════════════════════════ */

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(LibraryRoot::default())
        .manage(TagCatalogue::default())
        .manage(DirtyDrafts::default())
        .on_window_event(|window, event| {
            // Drafts are renderer-only state, and closing the window drops
            // them with no way back. Tauri routes closing through this event
            // rather than through the page's `beforeunload`, so the guard has
            // to live here; app.js keeps a `beforeunload` for reloads.
            let tauri::WindowEvent::CloseRequested { api, .. } = event else {
                return;
            };
            let count = window
                .state::<DirtyDrafts>()
                .0
                .lock()
                .map(|guard| *guard)
                .unwrap_or(0);
            if count == 0 {
                return;
            }
            api.prevent_close();

            let photos = if count == 1 {
                "1 photo has".to_string()
            } else {
                format!("{count} photos have")
            };
            let window = window.clone();
            tauri_plugin_dialog::DialogExt::dialog(window.app_handle())
                .message("Closing now discards them. Nothing has been written to your files yet.")
                .title(format!("{photos} unsaved changes"))
                .kind(tauri_plugin_dialog::MessageDialogKind::Warning)
                .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(
                    "Discard changes".into(),
                    "Cancel".into(),
                ))
                .show(move |discard| {
                    if !discard {
                        return;
                    }
                    // Cleared first, or destroying re-enters this handler and
                    // asks the same question again.
                    if let Ok(mut guard) = window.state::<DirtyDrafts>().0.lock() {
                        *guard = 0;
                    }
                    let _ = window.destroy();
                });
        })
        .setup(|app| {
            // In a bundle, ExifTool sits under the resource dir. In `tauri
            // dev`, resolve_resource points into the source tree, so walking up
            // to the repo root finds vendor/ either way.
            let resource_dir = app.path().resource_dir().unwrap_or_else(|_| PathBuf::from("."));
            let candidates = [
                resource_dir.clone(),
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .map(PathBuf::from)
                    .unwrap_or_default(),
            ];
            let exe = candidates
                .iter()
                .find_map(|dir| ExifToolSession::locate(dir).ok())
                .ok_or_else(|| {
                    format!(
                        "The bundled ExifTool is missing. Looked in: {}. \
                         Run `python3 build_tools/fetch_exiftool.py --all`.",
                        candidates
                            .iter()
                            .map(|p| p.display().to_string())
                            .collect::<Vec<_>>()
                            .join(", ")
                    )
                })?;
            app.manage(Engine(ExifToolSession::new(exe)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_library,
            rescan_library,
            read_metadata,
            read_fields,
            read_preview,
            read_file_bytes,
            read_thumb_cache,
            write_thumb_cache,
            set_dirty,
            engine_version,
            writable_tags,
            initial_folder,
            apply_edit,
            apply_edits,
            undo_last,
            undo_available,
            preview_geotag,
            apply_geotag,
            choose_gpx_file,
            export_csv,
            report_renderer,
            preview_date_shift,
        ])
        .run(tauri::generate_context!("tauri.conf.json"))
        .expect("error while running Revery Exif");
}
