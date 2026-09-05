//! Folder scanning, metadata reading and thumbnail extraction.
//!
//! Everything here is read-only. The write path lands in Phase 2 and must not
//! be bolted on before the integrity fixtures exist.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::exiftool::ExifToolSession;

/// Formats the app will open. Deliberately excludes RAW: writing metadata into
/// a proprietary RAW container is the wrong behaviour (XMP sidecars are the
/// correct answer), and offering to open what we cannot correctly save would
/// promise something the app does not yet do.
pub const SUPPORTED_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "jpe", "heic", "heif", "png", "tif", "tiff", "webp",
];

/// Formats no browser engine can decode, so the grid needs an embedded preview
/// extracted by ExifTool instead of an `<img src>` pointing at the file.
/// Chromium and WebKitGTK both refuse HEIC; TIFF support is inconsistent
/// enough across the two webviews that it is not worth relying on.
pub const NEEDS_EXTRACTED_PREVIEW: &[&str] = &["heic", "heif", "tif", "tiff"];

pub fn extension_of(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default()
}

pub fn is_supported(path: &Path) -> bool {
    SUPPORTED_EXTENSIONS.contains(&extension_of(path).as_str())
}

pub fn needs_extracted_preview(path: &Path) -> bool {
    NEEDS_EXTRACTED_PREVIEW.contains(&extension_of(path).as_str())
}

/// One photo as the grid sees it. Metadata is loaded separately and lazily —
/// scanning a folder must not block on reading tags from 2000 files.
#[derive(Debug, Clone, Serialize)]
pub struct PhotoEntry {
    pub path: String,
    pub name: String,
    pub size: u64,
    /// ms since epoch, matching JS `Date`.
    pub mtime: f64,
    /// Whether the webview can decode this file directly.
    pub needs_preview: bool,
}

/// Canonicalises a path, without Windows' extended-length `\\?\` prefix.
///
/// **Use this instead of `Path::canonicalize` everywhere.** `std::fs`
/// canonicalises to the *verbatim* form on Windows, so `C:\photos` comes back
/// as `\\?\C:\photos`. That prefix is right for the Win32 API and wrong for
/// nearly everything downstream of it.
///
/// ExifTool is the case that breaks. It rewrites every filename argument to
/// forward slashes on Windows (`CleanFilename`, applied to `@files` wholesale),
/// which turns the path into `//?/C:/photos/a.jpg` — and that is not something
/// Windows will open, because the `\\?\` prefix deliberately bypasses the
/// normalisation layer that would otherwise accept `/`. ExifTool can recover
/// via its `WindowsLongPath` option, but only when `Win32::API` loads inside
/// the bundled interpreter; when it does not, `Exists` falls back to a plain
/// `-e` on the mangled path and every read and every write fails with
/// `Error: File not found`, while the app looks otherwise healthy because the
/// webview loads its thumbnails over a different route entirely.
///
/// Nothing here needs paths past `MAX_PATH`, so the prefix buys nothing and
/// costs a whole class of failure. `dunce` strips it only when the result is a
/// path Windows accepts unprefixed, and is a plain canonicalise on Unix.
///
/// It deliberately keeps the prefix for the paths that genuinely need it —
/// over 260 characters, a reserved DOS name (`CON`, `NUL`), or a UNC share. A
/// library sitting somewhere like that is still exposed to the ExifTool
/// fragility above, because there is no unprefixed spelling to fall back on.
/// That is a much narrower case than "every folder on Windows", which is what
/// canonicalising without this produced.
pub fn canonical(path: &Path) -> std::io::Result<PathBuf> {
    dunce::canonicalize(path)
}

/// Resolves `candidate` and confirms it stays inside `root`.
///
/// Every command that touches a path goes through this. Canonicalising both
/// sides resolves `..` and symlinks *before* the comparison — a check done on
/// the unresolved string can be walked straight out of the folder with `..`,
/// and a symlink inside the library could otherwise point anywhere on disk.
///
/// Both sides go through `canonical`, so they are always in the same form and
/// `starts_with` compares like with like. Mixing a simplified path with a
/// verbatim one would make every check fail, since the prefix is a distinct
/// leading component rather than a string decoration.
pub fn resolve_within(root: &Path, candidate: &str) -> Result<PathBuf, String> {
    let root = canonical(root).map_err(|e| format!("Library folder is unavailable: {e}"))?;
    let resolved =
        canonical(Path::new(candidate)).map_err(|e| format!("Cannot resolve {candidate}: {e}"))?;
    if !resolved.starts_with(&root) {
        return Err(format!(
            "Refusing to touch a path outside the open folder: {candidate}"
        ));
    }
    Ok(resolved)
}

/// Lists supported images directly inside `root`.
///
/// Not recursive: a photo library is browsed a folder at a time, and silently
/// pulling in every nested subfolder would make a stray selection-all apply an
/// edit to thousands of files the user never saw.
pub fn scan_folder(root: &Path) -> Result<Vec<PhotoEntry>, String> {
    let mut entries = Vec::new();
    let dir = std::fs::read_dir(root).map_err(|e| format!("Cannot read folder: {e}"))?;
    for entry in dir {
        let entry = match entry {
            Ok(e) => e,
            // One unreadable entry must not abort the whole scan; the folder
            // is still usable without it.
            Err(_) => continue,
        };
        let path = entry.path();
        if !path.is_file() || !is_supported(&path) {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64() * 1000.0)
            .unwrap_or(0.0);
        entries.push(PhotoEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: path.to_string_lossy().into_owned(),
            size: meta.len(),
            mtime,
            needs_preview: needs_extracted_preview(&path),
        });
    }
    // Name order, case-insensitive: matches how every file manager presents a
    // photo folder, so the grid order is never a surprise.
    entries.sort_by_key(|e| e.name.to_lowercase());
    Ok(entries)
}

/* ══════════════════════════════════════════════════════════════════════════
   GPS
══════════════════════════════════════════════════════════════════════════ */

/// A location as the UI handles it: one signed decimal pair.
///
/// EXIF stores latitude as an *unsigned magnitude* plus a separate N/S
/// reference tag, which is the source of the classic wrong-hemisphere bug: a
/// signed value read from `Composite:` and written back to `EXIF:GPSLatitude`
/// gets its sign applied twice. This type exists so the sign lives in exactly
/// one place and the conversion happens at exactly one boundary.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct GpsPosition {
    /// Signed: negative is south.
    pub latitude: f64,
    /// Signed: negative is west.
    pub longitude: f64,
    /// Metres. Negative is below sea level.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub altitude: Option<f64>,
}

impl GpsPosition {
    pub fn is_valid(&self) -> bool {
        (-90.0..=90.0).contains(&self.latitude)
            && (-180.0..=180.0).contains(&self.longitude)
            && !self.latitude.is_nan()
            && !self.longitude.is_nan()
    }

    /// ExifTool arguments that write this position.
    ///
    /// One rule throughout: **the signed value goes to both the tag and its
    /// `Ref`**. ExifTool derives N/S/E/W (and above/below sea level) from the
    /// sign and stores the magnitude itself, which is verified to round-trip.
    ///
    /// Altitude follows the same rule as latitude and longitude, which is not
    /// obvious and is worth stating: writing the reference as the raw enum
    /// (`-GPSAltitudeRef=1` for "below sea level") is **silently ignored** —
    /// ExifTool accepts the argument, reports success, and stores "above sea
    /// level". Every below-sea-level photo would come back out at the wrong
    /// altitude with nothing anywhere reporting a problem.
    pub fn write_args(&self) -> Vec<String> {
        let mut args = vec![
            format!("-GPSLatitude={}", self.latitude),
            format!("-GPSLatitudeRef={}", self.latitude),
            format!("-GPSLongitude={}", self.longitude),
            format!("-GPSLongitudeRef={}", self.longitude),
        ];
        if let Some(altitude) = self.altitude {
            args.push(format!("-GPSAltitude={altitude}"));
            args.push(format!("-GPSAltitudeRef={altitude}"));
        }
        args
    }
}

/* ══════════════════════════════════════════════════════════════════════════
   READING METADATA
══════════════════════════════════════════════════════════════════════════ */

/// Arguments shared by every read.
///
/// * `-j`   JSON output.
/// * `-G`   group prefixes, so `EXIF:DateTimeOriginal` stays distinguishable
///          from `XMP:DateTimeOriginal` — they are different tags and the UI
///          must not merge them.
/// * `-n`   numeric values: GPS as decimals rather than `59 deg 54' 50.04"`.
/// * `-charset UTF8`  so non-ASCII titles and names survive the round trip.
///
/// Deliberately **not** `-struct`: it makes list-typed XMP fields come back as
/// arrays even when they hold a single value, but only some of them —
/// `XMP:Creator` becomes `["name"]` while `XMP:Title` stays a bare string. The
/// flattened default is uniform (bare string for one value, array for several)
/// and is what the inspector should display anyway. Structured XMP matters
/// only for regions and hierarchies, which this app does not edit.
fn base_read_args() -> Vec<String> {
    vec![
        "-j".into(),
        "-G".into(),
        "-n".into(),
        "-charset".into(),
        "UTF8".into(),
    ]
}

/// Reads the full tag set for one or more files.
///
/// Returns the parsed JSON array, one object per file, exactly as ExifTool
/// emits it. The frontend inspector renders this directly; the curated edit
/// panel picks named fields out of it.
pub fn read_metadata(
    session: &ExifToolSession,
    paths: &[PathBuf],
) -> Result<serde_json::Value, String> {
    if paths.is_empty() {
        return Ok(serde_json::Value::Array(Vec::new()));
    }
    let mut args = base_read_args();
    for path in paths {
        args.push(path.to_string_lossy().into_owned());
    }
    run_read(session, &args)
}

/// Reads **only the named tags** for the given files.
///
/// The same read as `read_metadata` with the tag list narrowed. That narrowing
/// is the whole point: a full `-j -G` dump is 10–25 KB per file, so a
/// four-thousand-photo folder is tens of megabytes of JSON in one response —
/// past the session's timeout, and past what is sensible to hand a webview.
/// A CSV export needs a dozen tags, which is under half a kilobyte per file.
///
/// A tag the file does not carry is simply absent from that file's object,
/// exactly as it is in a full read, so the caller's lookup logic is unchanged.
pub fn read_fields(
    session: &ExifToolSession,
    paths: &[PathBuf],
    tags: &[String],
) -> Result<serde_json::Value, String> {
    if paths.is_empty() {
        return Ok(serde_json::Value::Array(Vec::new()));
    }
    if tags.is_empty() {
        // `-j -G` with no tag arguments means *every* tag, which is the
        // opposite of what this function is for. An empty request is a caller
        // bug, and answering it with a full dump would hide that behind a
        // response that merely looks slow.
        return Err("A field read needs at least one tag".into());
    }

    let mut args = base_read_args();
    for tag in tags {
        // The tag list arrives from the renderer, and every argument on this
        // line is read by ExifTool as an *option* unless it is a filename. A
        // name that is not a plain tag name could therefore turn a read into
        // something else entirely, so the shape is checked rather than trusted.
        if !is_tag_name(tag) {
            return Err(format!("Not a tag name: {tag}"));
        }
        args.push(format!("-{tag}"));
    }
    for path in paths {
        args.push(path.to_string_lossy().into_owned());
    }
    run_read(session, &args)
}

/// `Group:Tag` — letters, digits and hyphens, and **the group is required**.
///
/// Deliberately narrower than what ExifTool accepts. It covers every tag this
/// app asks for (`XMP:Title`, `IPTC:Caption-Abstract`, `Composite:GPSLatitude`,
/// `File:ImageWidth`) and admits nothing that could be read as a filename or as
/// one of the argument forms that carry a value.
///
/// The group is what makes the rule safe rather than merely tidy. Each of these
/// is written back out as `-{tag}`, and ExifTool's own options are ungrouped
/// words: a bare name of `execute` becomes `-execute`, which ends the batch
/// early and desynchronises the session; `q`, `b`, `charset` and `stay_open`
/// are the same shape. No ExifTool option contains a colon, so requiring one
/// removes the entire collision rather than blacklisting the names known today.
///
/// Nothing is lost by it: every tag in the app is grouped, and `SourceFile` —
/// the one ungrouped key that matters — is emitted by `-j` regardless and is
/// never requested.
fn is_tag_name(tag: &str) -> bool {
    fn part_ok(part: &str) -> bool {
        !part.is_empty()
            && part.len() <= 64
            && part
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-')
    }
    match tag.split_once(':') {
        Some((group, name)) => part_ok(group) && part_ok(name),
        None => false,
    }
}

/// Runs a prepared read and parses what comes back.
///
/// Shared so the two readers cannot drift on the one subtlety here: a request
/// that fails produces no stdout at all, so empty output with an error on
/// stderr is a failure — never "a file with no metadata".
fn run_read(session: &ExifToolSession, args: &[String]) -> Result<serde_json::Value, String> {
    let response = session.execute(args)?;

    if response.stdout.trim().is_empty() {
        if response.has_error() {
            return Err(response.error_text());
        }
        return Ok(serde_json::Value::Array(Vec::new()));
    }

    serde_json::from_str(&response.stdout)
        .map_err(|e| format!("ExifTool returned JSON that could not be parsed: {e}"))
}

/// Pulls the signed position out of one file's metadata object.
///
/// Reads `Composite:` because that is the group carrying the sign; the raw
/// `EXIF:` values are magnitudes and would place southern-hemisphere photos in
/// the north.
pub fn position_from_metadata(entry: &serde_json::Value) -> Option<GpsPosition> {
    let latitude = entry.get("Composite:GPSLatitude")?.as_f64()?;
    let longitude = entry.get("Composite:GPSLongitude")?.as_f64()?;
    let altitude = entry.get("Composite:GPSAltitude").and_then(|v| v.as_f64());
    let position = GpsPosition {
        latitude,
        longitude,
        altitude,
    };
    position.is_valid().then_some(position)
}

/* ══════════════════════════════════════════════════════════════════════════
   THUMBNAILS
══════════════════════════════════════════════════════════════════════════ */

/// An extracted preview, ready to hand to an `<img>` as a data URI.
#[derive(Debug, Clone, Serialize)]
pub struct Preview {
    /// Base64 JPEG, no data-URI prefix.
    pub base64: String,
    /// The **parent file's** EXIF orientation (1–8), when it has one.
    ///
    /// An extracted preview is a bare JPEG blob: the rotation that applies to
    /// it lives in the container it came out of, not in the bytes themselves.
    /// A webview decoding a file directly reads orientation from that file and
    /// applies it silently, so the direct route needs nothing — but the
    /// extracted route hands over a blob with no orientation anywhere, and
    /// every portrait phone photo comes out sideways. Easy to miss in a 168 px
    /// tile; impossible to miss at full screen.
    ///
    /// Free to collect: it rides along in the extraction's own round trip.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orientation: Option<u16>,
}

/// The largest file the frontend may pull into memory whole.
///
/// A guard, not a policy: the only caller hands one photo at a time to the
/// HEIC decoder, and a HEIC that size does not exist. It is here so that a
/// mistaken call cannot base64 an arbitrarily large file into the webview and
/// take the window down with it.
pub const MAX_INLINE_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// Reads a whole file, base64-encoded, for decoding inside the webview.
///
/// This exists because **neither shell can simply fetch a local file.**
/// Chromium refuses `fetch` and `XMLHttpRequest` on `file://` whatever the CSP
/// says, so the Electron build cannot read its own photos that way; and Tauri's
/// `convertFileSrc` yields an `http://asset.localhost/…` URL that the app's
/// `connect-src 'self'` does not cover. Routing it through the core instead
/// costs a base64 round trip and works identically in both, which is worth more
/// than the bytes — and it reuses the containment guard every other path
/// already goes through, rather than opening a second way to name a file.
///
/// Base64 rather than a byte array because that is what the JSON transport
/// between the shells can carry, and it is what `extract_preview` already does.
pub fn read_file_bytes(root: &Path, candidate: &str) -> Result<String, String> {
    use base64::Engine as _;

    let path = resolve_within(root, candidate)?;
    let metadata =
        std::fs::metadata(&path).map_err(|e| format!("Cannot read {candidate}: {e}"))?;
    if !metadata.is_file() {
        return Err(format!("Not a file: {candidate}"));
    }
    if metadata.len() > MAX_INLINE_FILE_BYTES {
        return Err(format!(
            "That file is {} MB, past the {} MB the app will load into memory at once.",
            metadata.len() / (1024 * 1024),
            MAX_INLINE_FILE_BYTES / (1024 * 1024)
        ));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("Cannot read {candidate}: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Extracts the largest embedded preview from a file the webview cannot decode.
///
/// `-b` with `-j` returns binary tags base64-encoded inside the JSON, which
/// keeps previews on the same framed text channel as everything else instead
/// of needing a second binary pipe alongside the `-stay_open` session.
///
/// Tags are tried largest first: `PreviewImage` is typically a full-size JPEG,
/// `JpgFromRaw` appears in some containers, and `ThumbnailImage` is the small
/// 160×120 EXIF thumbnail that almost everything has as a last resort.
pub fn extract_preview(
    session: &ExifToolSession,
    path: &Path,
) -> Result<Option<Preview>, String> {
    let mut args = vec![
        "-j".into(),
        "-b".into(),
        "-PreviewImage".into(),
        "-JpgFromRaw".into(),
        "-ThumbnailImage".into(),
        // `-n` so this comes back as the number 6 rather than the prose
        // "Rotate 90 CW". Scoped to `EXIF:` because that is the tag that
        // describes how to display the image; `Composite:` has no equivalent
        // and an XMP copy can disagree with it.
        "-n".into(),
        "-EXIF:Orientation".into(),
        path.to_string_lossy().into_owned(),
    ];
    args.push("-charset".into());
    args.push("UTF8".into());

    let response = session.execute(&args)?;
    if response.stdout.trim().is_empty() {
        if response.has_error() {
            return Err(response.error_text());
        }
        return Ok(None);
    }

    let parsed: serde_json::Value = serde_json::from_str(&response.stdout)
        .map_err(|e| format!("ExifTool returned JSON that could not be parsed: {e}"))?;
    let entry = parsed.get(0).ok_or("ExifTool returned no entry")?;

    // Without `-G` the key comes back unprefixed, but accept both so adding a
    // group flag to the request later cannot silently drop the rotation.
    let orientation = entry
        .get("EXIF:Orientation")
        .or_else(|| entry.get("Orientation"))
        .and_then(|v| v.as_u64())
        // 1–8 are the defined values. Anything else is a corrupt tag, and
        // rotating by a garbage number is worse than not rotating at all.
        .filter(|value| (1..=8).contains(value))
        .map(|value| value as u16);

    for tag in ["PreviewImage", "JpgFromRaw", "ThumbnailImage"] {
        if let Some(value) = entry.get(tag).and_then(|v| v.as_str()) {
            if let Some(encoded) = value.strip_prefix("base64:") {
                if !encoded.is_empty() {
                    return Ok(Some(Preview {
                        base64: encoded.to_string(),
                        orientation,
                    }));
                }
            }
        }
    }
    // A HEIC with no embedded preview is rare but legal. The caller shows a
    // placeholder rather than treating it as an error.
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_supported_extensions_case_insensitively() {
        assert!(is_supported(Path::new("/photos/DSC_0001.JPG")));
        assert!(is_supported(Path::new("/photos/img.heic")));
        assert!(is_supported(Path::new("/photos/scan.TIFF")));
        // RAW is deliberately out of scope until the sidecar path exists.
        assert!(!is_supported(Path::new("/photos/IMG_1234.CR2")));
        assert!(!is_supported(Path::new("/photos/IMG_1234.NEF")));
        assert!(!is_supported(Path::new("/photos/notes.txt")));
        assert!(!is_supported(Path::new("/photos/no-extension")));
    }

    #[test]
    fn a_field_read_accepts_the_tags_the_export_asks_for() {
        for tag in [
            "XMP:Title",
            "IPTC:ObjectName",
            "IPTC:Caption-Abstract",
            "Composite:GPSLatitude",
            "EXIF:DateTimeOriginal",
            "File:ImageWidth",
        ] {
            assert!(is_tag_name(tag), "rejected a real tag: {tag}");
        }
    }

    #[test]
    fn a_field_read_refuses_anything_that_is_not_a_tag_name() {
        // Each of these becomes an argument on ExifTool's own command line, so
        // the shape is the whole guard: the renderer supplies this list, and
        // anything that is not a plain tag name could turn a read into some
        // other operation, or name a file.
        for tag in [
            "",
            "XMP:",
            ":Title",
            "XMP:Title=value",
            "-delete_original",
            "../photos/secret.jpg",
            "XMP:Title XMP:Description",
            // Ungrouped, and therefore `-execute` — which would end the
            // ExifTool batch early and desynchronise the session.
            "execute",
            "q",
            "stay_open",
            // Emitted by -j anyway, and ungrouped, so it is never requested.
            "SourceFile",
            "XMP::Title",
            "Title\n-q",
        ] {
            assert!(!is_tag_name(tag), "accepted a non-tag: {tag:?}");
        }
    }

    #[test]
    fn flags_only_formats_the_webview_cannot_decode() {
        assert!(needs_extracted_preview(Path::new("a.heic")));
        assert!(needs_extracted_preview(Path::new("a.HEIF")));
        assert!(needs_extracted_preview(Path::new("a.tif")));
        // The webview decodes these itself; extracting a preview would be
        // slower and lower quality than just pointing an <img> at the file.
        assert!(!needs_extracted_preview(Path::new("a.jpg")));
        assert!(!needs_extracted_preview(Path::new("a.png")));
        assert!(!needs_extracted_preview(Path::new("a.webp")));
    }

    #[test]
    fn gps_write_args_carry_the_sign_into_the_reference() {
        let oslo = GpsPosition {
            latitude: 59.9139,
            longitude: 10.7522,
            altitude: None,
        };
        let args = oslo.write_args();
        assert!(args.contains(&"-GPSLatitude=59.9139".to_string()));
        // The reference gets the signed value, not "N" — ExifTool derives the
        // hemisphere, so magnitude and reference cannot drift apart.
        assert!(args.contains(&"-GPSLatitudeRef=59.9139".to_string()));

        let sydney = GpsPosition {
            latitude: -33.8688,
            longitude: 151.2093,
            altitude: None,
        };
        let args = sydney.write_args();
        assert!(args.contains(&"-GPSLatitude=-33.8688".to_string()));
        assert!(args.contains(&"-GPSLatitudeRef=-33.8688".to_string()));
    }

    #[test]
    fn altitude_reference_gets_the_signed_value_not_the_enum() {
        let below = GpsPosition {
            latitude: 31.5,
            longitude: 35.5,
            altitude: Some(-430.0),
        };
        let args = below.write_args();
        assert!(args.contains(&"-GPSAltitude=-430".to_string()));
        // NOT "-GPSAltitudeRef=1". ExifTool silently ignores the raw enum and
        // stores "above sea level", so a below-sea-level photo would come back
        // out positive with no error anywhere. Verified against the binary in
        // tests/read_path.rs.
        assert!(args.contains(&"-GPSAltitudeRef=-430".to_string()));
        assert!(!args.iter().any(|a| a == "-GPSAltitudeRef=1"));

        let above = GpsPosition {
            latitude: 27.98,
            longitude: 86.92,
            altitude: Some(8849.0),
        };
        let args = above.write_args();
        assert!(args.contains(&"-GPSAltitude=8849".to_string()));
        assert!(args.contains(&"-GPSAltitudeRef=8849".to_string()));
    }

    #[test]
    fn rejects_out_of_range_positions() {
        assert!(!GpsPosition { latitude: 91.0, longitude: 0.0, altitude: None }.is_valid());
        assert!(!GpsPosition { latitude: 0.0, longitude: 181.0, altitude: None }.is_valid());
        assert!(!GpsPosition { latitude: f64::NAN, longitude: 0.0, altitude: None }.is_valid());
        assert!(GpsPosition { latitude: -90.0, longitude: 180.0, altitude: None }.is_valid());
    }

    #[test]
    fn reads_the_signed_position_not_the_magnitude() {
        // Shaped exactly like ExifTool -j -G -n output for a southern,
        // western photo: EXIF carries magnitudes, Composite carries the sign.
        let entry = serde_json::json!({
            "EXIF:GPSLatitude": 33.8688,
            "EXIF:GPSLatitudeRef": "S",
            "EXIF:GPSLongitude": 151.2093,
            "EXIF:GPSLongitudeRef": "W",
            "Composite:GPSLatitude": -33.8688,
            "Composite:GPSLongitude": -151.2093
        });
        let position = position_from_metadata(&entry).expect("position should parse");
        // Reading EXIF: instead would put this photo in the northern
        // hemisphere, off the coast of China rather than in Sydney.
        assert_eq!(position.latitude, -33.8688);
        assert_eq!(position.longitude, -151.2093);
    }

    #[test]
    fn absent_gps_is_none_not_zero() {
        // A photo with no GPS must not land at (0, 0) in the Gulf of Guinea.
        let entry = serde_json::json!({ "EXIF:Make": "Canon" });
        assert!(position_from_metadata(&entry).is_none());
    }

    /// The one command that hands a whole file to the frontend must not be a
    /// way around the containment guard.
    ///
    /// Every other path-taking command reads *metadata*. This one returns the
    /// bytes, so a missing guard here is not "the wrong tags were shown" but
    /// "any file on disk can be read by the webview". It goes through
    /// `resolve_within` like everything else, and this pins that it does.
    #[test]
    fn reading_bytes_is_confined_to_the_open_folder() {
        use base64::Engine as _;

        let root = std::env::temp_dir().join("revery-exif-bytes-test");
        let outside = std::env::temp_dir().join("revery-exif-bytes-outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(root.join("a.jpg"), b"inside").unwrap();
        let secret = outside.join("secret.jpg");
        std::fs::write(&secret, b"outside").unwrap();

        let root = canonical(&root).unwrap();

        let encoded = read_file_bytes(&root, root.join("a.jpg").to_str().unwrap()).unwrap();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        assert_eq!(decoded, b"inside");

        // Outright, and via a traversal that resolves out of the folder.
        assert!(read_file_bytes(&root, secret.to_str().unwrap()).is_err());
        let escape = root.join("../revery-exif-bytes-outside/secret.jpg");
        assert!(read_file_bytes(&root, escape.to_str().unwrap()).is_err());

        // A directory is not a file, and must not come back as one.
        assert!(read_file_bytes(&root, root.to_str().unwrap()).is_err());

        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&outside).ok();
    }

    /// The cap is checked before the read, not after.
    ///
    /// Checking afterwards would mean the file is already in memory by the
    /// time the limit is noticed, which is precisely what the limit exists to
    /// prevent.
    #[test]
    fn the_size_cap_is_a_real_limit_and_is_stated_in_the_error() {
        let root = std::env::temp_dir().join("revery-exif-bytes-cap-test");
        std::fs::create_dir_all(&root).unwrap();
        let root = canonical(&root).unwrap();
        let big = root.join("big.tif");
        // Sparse: the length is what is checked, so this costs no real disk.
        let file = std::fs::File::create(&big).unwrap();
        file.set_len(MAX_INLINE_FILE_BYTES + 1).unwrap();
        drop(file);

        let error = read_file_bytes(&root, big.to_str().unwrap()).unwrap_err();
        assert!(
            error.contains("64 MB"),
            "the error should say what the limit is: {error}"
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn path_guard_blocks_traversal_out_of_the_library() {
        let root = std::env::temp_dir().join("revery-exif-guard-test");
        let inside = root.join("inside");
        std::fs::create_dir_all(&inside).unwrap();
        let photo = inside.join("a.jpg");
        std::fs::write(&photo, b"x").unwrap();

        assert!(resolve_within(&root, photo.to_str().unwrap()).is_ok());

        // `..` must be resolved before the comparison, not after.
        let escape = inside.join("../../etc/passwd");
        assert!(resolve_within(&root, escape.to_str().unwrap()).is_err());

        std::fs::remove_dir_all(&root).ok();
    }

    /// The paths handed to the frontend must be paths ExifTool can open.
    ///
    /// `Path::canonicalize` returns the verbatim `\\?\C:\...` form on Windows.
    /// ExifTool rewrites every filename argument to forward slashes, and
    /// `//?/C:/...` is not a path Windows will open — so a prefix leaking out
    /// of `scan_folder` makes every read and every write fail with
    /// `Error: File not found`, on Windows only, while the app otherwise looks
    /// perfectly healthy. Asserted on all platforms so the shape of the
    /// contract is visible even where it cannot regress.
    #[test]
    fn emitted_paths_carry_no_verbatim_prefix_and_resolve_back() {
        let root = std::env::temp_dir().join("revery-exif-prefix-test");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.jpg"), b"x").unwrap();

        // The root itself, as `open_library` derives it.
        let resolved = canonical(&root).unwrap();
        assert!(
            !resolved.to_string_lossy().starts_with(r"\\?\"),
            "the library root is verbatim: {}",
            resolved.display()
        );

        let entries = scan_folder(&resolved).unwrap();
        let photo = &entries[0].path;
        assert!(
            !photo.starts_with(r"\\?\"),
            "an emitted photo path is verbatim: {photo}"
        );

        // The round trip is the part that actually matters: the frontend hands
        // this exact string back, and what comes out of the guard is what
        // reaches ExifTool.
        let back = resolve_within(&resolved, photo).unwrap();
        assert_eq!(back.to_string_lossy(), *photo);

        std::fs::remove_dir_all(&root).ok();
    }

    /// Dropping the prefix must not have loosened the containment check.
    ///
    /// `starts_with` compares path *components*, and the verbatim prefix is one
    /// of them — so simplifying one side and not the other would make every
    /// comparison fail, and simplifying neither would leave the guard correct
    /// but the paths unusable. Both sides go through `canonical` for that
    /// reason, and this pins it.
    #[test]
    fn the_guard_still_holds_with_prefixes_stripped() {
        let root = std::env::temp_dir().join("revery-exif-guard-prefix-test");
        // Named so its *string* starts with the root's, which is the case a
        // naive `starts_with` on the rendered path would wave through.
        let outside = std::env::temp_dir().join("revery-exif-guard-prefix-test-sibling");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(root.join("in.jpg"), b"x").unwrap();
        let secret = outside.join("out.jpg");
        std::fs::write(&secret, b"x").unwrap();

        let root = canonical(&root).unwrap();
        assert!(resolve_within(&root, root.join("in.jpg").to_str().unwrap()).is_ok());
        assert!(resolve_within(&root, secret.to_str().unwrap()).is_err());
        // A sibling whose name merely *starts with* the root's must not pass —
        // component comparison, not string prefix.
        assert!(resolve_within(&root, outside.to_str().unwrap()).is_err());

        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn scan_lists_only_supported_files_in_name_order() {
        let root = std::env::temp_dir().join("revery-exif-scan-test");
        std::fs::create_dir_all(&root).unwrap();
        for name in ["b.jpg", "A.PNG", "notes.txt", "raw.CR2", "c.heic"] {
            std::fs::write(root.join(name), b"x").unwrap();
        }
        std::fs::create_dir_all(root.join("subfolder")).unwrap();
        std::fs::write(root.join("subfolder/deep.jpg"), b"x").unwrap();

        let entries = scan_folder(&root).unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        // Case-insensitive name order; no .txt, no RAW, and nothing pulled up
        // out of the subfolder.
        assert_eq!(names, vec!["A.PNG", "b.jpg", "c.heic"]);
        assert!(entries.iter().find(|e| e.name == "c.heic").unwrap().needs_preview);
        assert!(!entries.iter().find(|e| e.name == "b.jpg").unwrap().needs_preview);

        std::fs::remove_dir_all(&root).ok();
    }
}
