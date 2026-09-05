//! A thumbnail cache that survives the process.
//!
//! # Why this exists
//!
//! Every thumbnail the app has ever drawn was recomputed from scratch on the
//! next launch. That is invisible for JPEGs, where the webview decodes the file
//! directly, and it is nearly invisible for phone HEICs, where ExifTool copies
//! out a 160x120 EXIF thumbnail in about four milliseconds. It stops being
//! invisible the moment a thumbnail has to be *decoded* — a HEIC's own `thmb`
//! item, or worse, a converter-produced file's full-resolution primary image.
//!
//! The comparison that motivated it: a Linux file manager showing the same
//! folder instantly, because it wrote its thumbnails to `~/.cache/thumbnails`
//! once and has been reading them back ever since. This is that, scoped to one
//! app.
//!
//! # What it is not
//!
//! Not the in-memory cache. `www/js/preview_cache.js` remains the hot tier and
//! is unchanged; this sits behind it and is consulted on a miss. Losing this
//! directory costs time, never correctness — every entry is reproducible from
//! the photo it came from.
//!
//! # Staleness
//!
//! The key covers the file's modification time and size, so an edited photo
//! does not match its old entry: it misses, and is recomputed. That matters
//! here more than in most caches, because this app *writes to the photos it is
//! displaying* — a cache keyed on path alone would show pre-edit thumbnails
//! until something happened to evict them.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// Bumped when the stored bytes stop meaning what they used to.
///
/// Part of the key, so a bump orphans old entries rather than misreading them;
/// the sweep then reclaims the space in the ordinary way.
const FORMAT_VERSION: u32 = 1;

/// Total bytes of cached thumbnails tolerated before the oldest are dropped.
///
/// Deliberately generous. A tile-sized JPEG is 10–20 KB, so this is on the
/// order of tens of thousands of photos, and the cost of being wrong in this
/// direction is disk space the user can delete. The cost of being wrong in the
/// other is the decode this exists to avoid.
const MAX_CACHE_BYTES: u64 = 256 * 1024 * 1024;

/// The largest thumbnail accepted from the renderer.
///
/// A tile JPEG is tens of kilobytes; this is far above anything legitimate and
/// exists so a bug on the other side cannot fill the disk one call at a time.
const MAX_ENTRY_BYTES: usize = 4 * 1024 * 1024;

/// Edges the renderer is allowed to ask for.
///
/// The write side of this module is reachable from the webview, so the key's
/// inputs are constrained rather than trusted. An unbounded edge would let a
/// caller mint unlimited distinct keys for one photo and defeat the sweep.
/// These are `TILE_SIZES` from `grid.js` plus the decode edge it asks for.
const ALLOWED_EDGES: &[u32] = &[120, 168, 224, 288, 512];

/// Where thumbnails live, created on first use.
///
/// Hand-rolled rather than pulled from a crate: the core binary has no Tauri
/// app handle to ask, and this is the whole of what `dirs` would have provided.
fn cache_root() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);

    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Caches"));

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let base = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")));

    base.map(|b| b.join("revery_exif").join("thumbs"))
        .ok_or_else(|| "No cache directory on this system".to_string())
}

/// Whether `edge` is one the grid actually draws.
fn edge_is_allowed(edge: u32) -> bool {
    ALLOWED_EDGES.contains(&edge)
}

/// The file a thumbnail for `path` at `edge` would be stored in.
///
/// The photo's path is an *input to the hash*, never a component of the
/// result. Nothing a caller passes can steer the write anywhere but into the
/// cache directory, under a name that is 64 hex characters by construction.
///
/// Sharded on the first two characters because a flat directory of tens of
/// thousands of entries is slow to enumerate on every filesystem worth naming,
/// and the sweep enumerates the whole tree.
fn entry_path(root: &Path, path: &Path, edge: u32) -> Result<PathBuf, String> {
    let metadata = std::fs::metadata(path).map_err(|e| format!("Cannot stat the photo: {e}"))?;
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);

    let mut hasher = Sha256::new();
    hasher.update(FORMAT_VERSION.to_le_bytes());
    hasher.update(path.to_string_lossy().as_bytes());
    hasher.update([0]); // Separator, so path+mtime cannot collide by sliding.
    hasher.update(mtime.to_le_bytes());
    hasher.update(metadata.len().to_le_bytes());
    hasher.update(edge.to_le_bytes());
    let digest = format!("{:x}", hasher.finalize());

    Ok(root.join(&digest[0..2]).join(format!("{digest}.jpg")))
}

/// Returns the cached thumbnail for `path` at `edge`, base64-encoded.
///
/// A miss is `Ok(None)`, and so is anything that went wrong reading it. There
/// is no failure mode here worth surfacing to the user: the caller's response
/// to "no" is to compute the thumbnail, which is what it would have done
/// anyway.
pub fn read(path: &Path, edge: u32) -> Result<Option<String>, String> {
    let Ok(root) = cache_root() else {
        return Ok(None);
    };
    read_in(&root, path, edge)
}

/// `read`, against an explicit cache root.
///
/// The root is a parameter rather than something resolved inside, so tests can
/// point at a scratch directory. The alternative — overriding `HOME` or
/// `XDG_CACHE_HOME` — is process-wide state, and `cargo test` runs tests on
/// threads: two of them setting it at once is a race, which is exactly how
/// this was first written and exactly how it first failed.
fn read_in(root: &Path, path: &Path, edge: u32) -> Result<Option<String>, String> {
    use base64::Engine as _;

    if !edge_is_allowed(edge) {
        return Ok(None);
    }
    let Ok(entry) = entry_path(root, path, edge) else {
        return Ok(None);
    };
    match std::fs::read(&entry) {
        Ok(bytes) if !bytes.is_empty() => {
            Ok(Some(base64::engine::general_purpose::STANDARD.encode(bytes)))
        }
        _ => Ok(None),
    }
}

/// Stores a thumbnail for `path` at `edge`.
///
/// Written through `write::atomic_write`, so a crash or a full disk leaves
/// either the previous entry or none — never a truncated JPEG that would be
/// read back as a corrupt tile for as long as the photo went unedited.
///
/// Refuses rather than errors on an implausible request. This is the one
/// renderer-reachable write in the app that is not aimed at a photo, and the
/// constraints are here rather than at the call site so they cannot be
/// forgotten by a second caller.
pub fn write(path: &Path, edge: u32, base64_jpeg: &str) -> Result<(), String> {
    let root = cache_root()?;
    write_in(&root, path, edge, base64_jpeg)
}

/// `write`, against an explicit cache root. See `read_in`.
fn write_in(root: &Path, path: &Path, edge: u32, base64_jpeg: &str) -> Result<(), String> {
    use base64::Engine as _;

    if !edge_is_allowed(edge) {
        return Err(format!("Not a thumbnail size this app draws: {edge}"));
    }
    if base64_jpeg.len() > MAX_ENTRY_BYTES * 4 / 3 + 4 {
        return Err("That thumbnail is too large to cache".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_jpeg)
        .map_err(|e| format!("The thumbnail was not valid base64: {e}"))?;
    if bytes.is_empty() || bytes.len() > MAX_ENTRY_BYTES {
        return Err("That thumbnail is not a plausible size".into());
    }
    // JPEG SOI. Cheap, and it keeps the cache to one format so the sweep and a
    // future reader do not have to sniff.
    if bytes[0] != 0xFF || bytes.get(1) != Some(&0xD8) {
        return Err("Only JPEG thumbnails are cached".into());
    }

    let entry = entry_path(root, path, edge)?;
    if let Some(parent) = entry.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Cannot create the thumbnail cache: {e}"))?;
    }
    crate::write::atomic_write(&entry, &bytes)
}

/// Drops the oldest entries until the cache is under its byte budget.
///
/// Called when a folder is opened, beside the temp and undo sweeps, because
/// that is the moment the app is already touching the filesystem and is not
/// yet drawing anything.
///
/// Oldest by modification time rather than by access time: `atime` is disabled
/// or coarsened on most systems now (`relatime`), so it cannot be relied on to
/// order entries. The consequence is that this evicts least-recently-*written*
/// rather than least-recently-used, which is the wrong policy in theory and
/// almost never distinguishable in practice for a cache this size.
///
/// Returns the number of entries removed.
pub fn sweep() -> usize {
    let Ok(root) = cache_root() else {
        return 0;
    };
    sweep_in(&root, MAX_CACHE_BYTES)
}

/// `sweep`, against an explicit cache root and budget. See `read_in`.
fn sweep_in(root: &Path, budget: u64) -> usize {
    let mut entries: Vec<(std::time::SystemTime, u64, PathBuf)> = Vec::new();
    let mut total: u64 = 0;

    let Ok(shards) = std::fs::read_dir(root) else {
        return 0;
    };
    for shard in shards.flatten() {
        let Ok(files) = std::fs::read_dir(shard.path()) else {
            continue;
        };
        for file in files.flatten() {
            let Ok(meta) = file.metadata() else { continue };
            if !meta.is_file() {
                continue;
            }
            total += meta.len();
            entries.push((
                meta.modified().unwrap_or(std::time::UNIX_EPOCH),
                meta.len(),
                file.path(),
            ));
        }
    }

    if total <= budget {
        return 0;
    }

    entries.sort_by_key(|(modified, _, _)| *modified);
    let mut removed = 0;
    for (_, size, path) in entries {
        if total <= budget {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(size);
            removed += 1;
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch cache root and a scratch photo directory, isolated per test.
    ///
    /// Named after the test rather than shared, so nothing here depends on the
    /// order `cargo test` happens to run things in.
    fn scratch(name: &str) -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("revery_thumbcache_{name}"));
        let _ = std::fs::remove_dir_all(&base);
        let cache = base.join("cache");
        let photos = base.join("photos");
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::create_dir_all(&photos).unwrap();
        (cache, photos)
    }

    fn photo(dir: &Path, name: &str, contents: &[u8]) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, contents).unwrap();
        path
    }

    /// A minimal byte string that passes the SOI check.
    fn jpeg() -> Vec<u8> {
        let mut bytes = vec![0xFF, 0xD8];
        bytes.extend_from_slice(&[0u8; 64]);
        bytes
    }

    fn b64(bytes: &[u8]) -> String {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[test]
    fn a_thumbnail_survives_the_round_trip() {
        let (cache, photos) = scratch("roundtrip");
        let path = photo(&photos, "a.heic", b"original");

        assert_eq!(read_in(&cache, &path, 512).unwrap(), None, "nothing cached yet");
        write_in(&cache, &path, 512, &b64(&jpeg())).unwrap();
        assert_eq!(read_in(&cache, &path, 512).unwrap(), Some(b64(&jpeg())));
    }

    #[test]
    fn editing_the_photo_misses_rather_than_serving_the_old_thumbnail() {
        let (cache, photos) = scratch("staleness");
        let path = photo(&photos, "b.heic", b"original");
        write_in(&cache, &path, 512, &b64(&jpeg())).unwrap();
        assert!(read_in(&cache, &path, 512).unwrap().is_some());

        // What an edit does: same path, different contents, different mtime.
        // The app writes to the photos it displays, so this is the case that
        // decides whether the grid shows pre-edit thumbnails.
        std::thread::sleep(std::time::Duration::from_millis(10));
        std::fs::write(&path, b"edited, and a different length").unwrap();

        assert_eq!(read_in(&cache, &path, 512).unwrap(), None);
    }

    #[test]
    fn each_size_is_cached_separately() {
        let (cache, photos) = scratch("sizes");
        let path = photo(&photos, "c.heic", b"original");
        write_in(&cache, &path, 288, &b64(&jpeg())).unwrap();

        assert!(read_in(&cache, &path, 288).unwrap().is_some());
        assert_eq!(read_in(&cache, &path, 512).unwrap(), None);
    }

    #[test]
    fn only_sizes_the_grid_draws_are_accepted() {
        let (cache, photos) = scratch("edges");
        let path = photo(&photos, "d.heic", b"original");

        // Unbounded edges would let one photo mint unlimited keys, which is
        // both a disk-fill and a way to walk straight past the sweep.
        assert!(write_in(&cache, &path, 9999, &b64(&jpeg())).is_err());
        assert!(write_in(&cache, &path, 0, &b64(&jpeg())).is_err());
        assert_eq!(read_in(&cache, &path, 9999).unwrap(), None);
        assert!(write_in(&cache, &path, 512, &b64(&jpeg())).is_ok());
    }

    #[test]
    fn only_jpeg_is_stored() {
        let (cache, photos) = scratch("format");
        let path = photo(&photos, "e.heic", b"original");

        assert!(write_in(&cache, &path, 512, &b64(b"\x89PNG\r\n\x1a\n")).is_err());
        assert!(write_in(&cache, &path, 512, &b64(b"")).is_err());
        assert!(write_in(&cache, &path, 512, "not base64 at all!!").is_err());
    }

    #[test]
    fn the_photo_path_never_becomes_the_destination() {
        let (cache, photos) = scratch("traversal");
        // A name doing its best to escape. It is hashed, so it cannot.
        let path = photo(&photos, "..a..b.heic", b"original");
        write_in(&cache, &path, 512, &b64(&jpeg())).unwrap();

        let entry = entry_path(&cache, &path, 512).unwrap();
        assert!(entry.starts_with(&cache));
        let name = entry.file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(name.len(), 64 + 4, "64 hex characters and .jpg");
        assert!(name.ends_with(".jpg"));
        assert!(name[..64].chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn a_missing_photo_is_a_miss_not_an_error() {
        let (cache, photos) = scratch("missing");
        let path = photos.join("never_existed.heic");

        // The key needs the file's mtime and size, so a deleted photo cannot
        // be looked up. That is a miss, not something to report.
        assert_eq!(read_in(&cache, &path, 512).unwrap(), None);
    }

    #[test]
    fn the_sweep_drops_the_oldest_first_and_stops_at_the_budget() {
        let (cache, photos) = scratch("sweep");
        let big = {
            let mut bytes = jpeg();
            bytes.resize(1000, 0);
            bytes
        };

        // Four entries, written oldest-first with distinguishable mtimes.
        let mut paths = Vec::new();
        for i in 0..4 {
            let path = photo(&photos, &format!("s{i}.heic"), format!("photo {i}").as_bytes());
            write_in(&cache, &path, 512, &b64(&big)).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(10));
            paths.push(path);
        }
        for path in &paths {
            assert!(read_in(&cache, path, 512).unwrap().is_some());
        }

        // Budget for roughly two of them.
        let removed = sweep_in(&cache, 2500);
        assert!(removed >= 1, "something should have been dropped");

        // The survivors are the newest; the casualties are the oldest.
        assert_eq!(read_in(&cache, &paths[0], 512).unwrap(), None);
        assert!(read_in(&cache, &paths[3], 512).unwrap().is_some());
    }

    #[test]
    fn a_cache_under_budget_is_left_alone() {
        let (cache, photos) = scratch("sweep_noop");
        let path = photo(&photos, "keep.heic", b"original");
        write_in(&cache, &path, 512, &b64(&jpeg())).unwrap();

        assert_eq!(sweep_in(&cache, MAX_CACHE_BYTES), 0);
        assert!(read_in(&cache, &path, 512).unwrap().is_some());
    }
}
