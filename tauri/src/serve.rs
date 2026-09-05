//! `revery-exif-core` — the shared core as a line-oriented JSON service.
//!
//! The Tauri shell links `lib.rs` directly. Electron cannot, so it spawns this
//! binary and talks to it over stdin/stdout instead.
//!
//! The alternative was reimplementing the core in Node for the Electron build:
//! a second ExifTool session, a second atomic-write path, a second undo
//! implementation, a second GPX parser. That would double the number of things
//! that can be wrong about somebody's photographs, and only one of the two
//! would have the integrity tests. One core, two shells.
//!
//! # Protocol
//!
//! One JSON object per line, in both directions.
//!
//! ```text
//! →  {"id":1,"cmd":"open_library","args":{"path":"/photos"}}
//! ←  {"id":1,"ok":true,"result":[…]}
//! ←  {"id":2,"ok":false,"error":"No folder is open"}
//! ```
//!
//! Every response carries the `id` it answers, so the caller matches by number
//! rather than by ordering — the same reason the ExifTool session does.
//! Requests are handled one at a time; the work is dominated by ExifTool, which
//! is serialised anyway.
//!
//! Anything user-facing that is not core logic — file dialogs, window
//! management — stays in the shell. This binary only touches metadata.

use std::io::{BufRead, Write};
use std::path::PathBuf;

use revery_exif_core::catalogue::{self, TagInfo};
use revery_exif_core::exiftool::ExifToolSession;
use revery_exif_core::{gpx, library, thumbcache, undo, write};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
struct Request {
    id: u64,
    cmd: String,
    #[serde(default)]
    args: Value,
}

struct State {
    session: ExifToolSession,
    root: Option<PathBuf>,
    /// Built on first use, then reused. See the Tauri side for why it is not
    /// built at launch: seconds of ExifTool most sessions never need.
    tag_catalogue: Option<Vec<TagInfo>>,
}

impl State {
    fn root(&self) -> Result<&PathBuf, String> {
        self.root.as_ref().ok_or_else(|| "No folder is open".into())
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    let serve = args.any(|a| a == "--serve");
    if !serve {
        eprintln!(
            "revery-exif-core — the metadata engine behind Revery Exif.\n\
             \n\
             This is not meant to be run directly; the app starts it.\n\
             \n\
             Usage: revery-exif-core --serve    (JSON lines on stdin/stdout)"
        );
        std::process::exit(2);
    }

    // Located relative to this executable so the sidecar works wherever the
    // shell placed it, rather than depending on the working directory.
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."));
    let candidates = [
        exe_dir.clone(),
        exe_dir.join("resources"),
        exe_dir.join(".."),
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(PathBuf::from)
            .unwrap_or_default(),
    ];
    let Some(exe) = candidates
        .iter()
        .find_map(|dir| ExifToolSession::locate(dir).ok())
    else {
        // Fatal and worth saying loudly: without the engine nothing works, and
        // the shell should surface this rather than fail on the first folder.
        eprintln!(
            "The bundled ExifTool is missing. Looked in: {}",
            candidates
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        );
        std::process::exit(3);
    };

    let mut state = State {
        session: ExifToolSession::new(exe),
        root: None,
        tag_catalogue: None,
    };

    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Request>(&line) {
            Ok(request) => {
                let id = request.id;
                match dispatch(&mut state, &request.cmd, request.args) {
                    Ok(result) => json!({ "id": id, "ok": true, "result": result }),
                    Err(error) => json!({ "id": id, "ok": false, "error": error }),
                }
            }
            // A malformed line has no id to answer, so it is reported with 0 —
            // the shell logs it rather than hanging waiting for a reply.
            Err(e) => json!({ "id": 0, "ok": false, "error": format!("Bad request: {e}") }),
        };
        if writeln!(stdout, "{response}").is_err() || stdout.flush().is_err() {
            break; // the shell went away
        }
    }

    state.session.shutdown();
}

/// Pulls a named argument out of the request.
fn arg<T: for<'de> Deserialize<'de>>(args: &Value, name: &str) -> Result<T, String> {
    serde_json::from_value(args.get(name).cloned().unwrap_or(Value::Null))
        .map_err(|e| format!("Argument `{name}` is wrong: {e}"))
}

fn dispatch(state: &mut State, cmd: &str, args: Value) -> Result<Value, String> {
    match cmd {
        "engine_version" => {
            let response = state.session.execute(&["-ver".into()])?;
            Ok(json!(response.stdout.trim()))
        }

        "writable_tags" => {
            // Cached on the state for the life of the process, same as Tauri.
            if state.tag_catalogue.is_none() {
                state.tag_catalogue = Some(catalogue::writable_tags(&state.session)?);
            }
            Ok(serde_json::to_value(state.tag_catalogue.as_ref().expect("just set"))
                .map_err(|e| e.to_string())?)
        }

        "open_library" => {
            let path: String = arg(&args, "path")?;
            // See library::canonical — the raw canonical form carries a `\\?\`
            // prefix on Windows that ExifTool cannot open.
            let resolved = library::canonical(std::path::Path::new(&path))
                .map_err(|e| format!("Cannot open {path}: {e}"))?;
            if !resolved.is_dir() {
                return Err(format!("Not a folder: {path}"));
            }
            write::sweep_stale_temps(&resolved);
            undo::sweep(&resolved);
            thumbcache::sweep();
            let entries = library::scan_folder(&resolved)?;
            state.root = Some(resolved);
            Ok(serde_json::to_value(entries).map_err(|e| e.to_string())?)
        }

        "rescan_library" => {
            let entries = library::scan_folder(state.root()?)?;
            Ok(serde_json::to_value(entries).map_err(|e| e.to_string())?)
        }

        "read_metadata" => {
            let paths: Vec<String> = arg(&args, "paths")?;
            let root = state.root()?;
            let resolved = paths
                .iter()
                .map(|p| library::resolve_within(root, p))
                .collect::<Result<Vec<_>, _>>()?;
            library::read_metadata(&state.session, &resolved)
        }

        "read_fields" => {
            let paths: Vec<String> = arg(&args, "paths")?;
            let tags: Vec<String> = arg(&args, "tags")?;
            let root = state.root()?;
            let resolved = paths
                .iter()
                .map(|p| library::resolve_within(root, p))
                .collect::<Result<Vec<_>, _>>()?;
            library::read_fields(&state.session, &resolved, &tags)
        }

        "read_preview" => {
            let path: String = arg(&args, "path")?;
            let resolved = library::resolve_within(state.root()?, &path)?;
            let preview = library::extract_preview(&state.session, &resolved)?;
            Ok(serde_json::to_value(preview).map_err(|e| e.to_string())?)
        }

        "read_file_bytes" => {
            let path: String = arg(&args, "path")?;
            Ok(json!(library::read_file_bytes(state.root()?, &path)?))
        }

        "read_thumb_cache" => {
            let path: String = arg(&args, "path")?;
            let edge: u32 = arg(&args, "edge")?;
            let resolved = library::resolve_within(state.root()?, &path)?;
            Ok(json!(thumbcache::read(&resolved, edge)?))
        }

        "write_thumb_cache" => {
            let path: String = arg(&args, "path")?;
            let edge: u32 = arg(&args, "edge")?;
            let base64: String = arg(&args, "base64")?;
            let resolved = library::resolve_within(state.root()?, &path)?;
            thumbcache::write(&resolved, edge, &base64)?;
            Ok(json!(true))
        }

        "apply_edit" => {
            let paths: Vec<String> = arg(&args, "paths")?;
            let edit: write::PhotoEdit = arg(&args, "edit")?;
            let outcome = write::apply_batch(&state.session, state.root()?, &paths, &edit)?;
            Ok(serde_json::to_value(outcome).map_err(|e| e.to_string())?)
        }

        "apply_edits" => {
            let edits: Vec<(String, write::PhotoEdit)> = arg(&args, "edits")?;
            let outcome = write::apply_per_file(&state.session, state.root()?, &edits)?;
            Ok(serde_json::to_value(outcome).map_err(|e| e.to_string())?)
        }

        "preview_geotag" => {
            let paths: Vec<String> = arg(&args, "paths")?;
            let gpx_path: String = arg(&args, "gpxPath")?;
            let offset: i64 = arg(&args, "offsetSeconds")?;
            let max_gap: Option<i64> = arg(&args, "maxGapSeconds").unwrap_or(None);

            let xml = std::fs::read_to_string(&gpx_path)
                .map_err(|e| format!("Cannot read {gpx_path}: {e}"))?;
            let track = gpx::Track::parse(&xml)?;
            let root = state.root()?;
            let resolved = paths
                .iter()
                .map(|p| library::resolve_within(root, p))
                .collect::<Result<Vec<_>, _>>()?;
            let metadata = library::read_metadata(&state.session, &resolved)?;
            let entries = metadata.as_array().cloned().unwrap_or_default();
            let matches = gpx::match_photos(
                &track,
                &entries,
                offset,
                max_gap.unwrap_or(gpx::DEFAULT_MAX_GAP_SECS),
            );
            Ok(serde_json::to_value(gpx::GeotagPreview::build(&track, matches))
                .map_err(|e| e.to_string())?)
        }

        "apply_geotag" => {
            #[derive(Deserialize)]
            struct Assignment {
                path: String,
                position: library::GpsPosition,
            }
            let assignments: Vec<Assignment> = arg(&args, "matches")?;
            let edits: Vec<(String, write::PhotoEdit)> = assignments
                .into_iter()
                .map(|a| {
                    let mut edit = write::PhotoEdit::default();
                    edit.gps = Some(write::GpsEdit::Set { position: a.position });
                    (a.path, edit)
                })
                .collect();
            if edits.is_empty() {
                return Err("None of the selected photos matched the track.".into());
            }
            let outcome = write::apply_per_file(&state.session, state.root()?, &edits)?;
            Ok(serde_json::to_value(outcome).map_err(|e| e.to_string())?)
        }

        "preview_date_shift" => {
            let paths: Vec<String> = arg(&args, "paths")?;
            let seconds: i64 = arg(&args, "seconds")?;
            let root = state.root()?;
            let resolved = paths
                .iter()
                .map(|p| library::resolve_within(root, p))
                .collect::<Result<Vec<_>, _>>()?;
            let metadata = library::read_metadata(&state.session, &resolved)?;
            let rows: Vec<Value> = metadata
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
                            json!({
                                "path": entry.get("SourceFile").and_then(|v| v.as_str()).unwrap_or_default(),
                                "before": before,
                                "after": after,
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            Ok(Value::Array(rows))
        }

        "undo_last" => {
            let outcome = undo::undo_last(state.root()?)?;
            Ok(serde_json::to_value(outcome).map_err(|e| e.to_string())?)
        }

        "undo_available" => Ok(json!(state
            .root
            .as_ref()
            .map(|r| undo::is_available(r))
            .unwrap_or(false))),

        other => Err(format!("Unknown command: {other}")),
    }
}
