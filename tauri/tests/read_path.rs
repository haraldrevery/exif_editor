//! End-to-end read path against the real ExifTool binary and real files.
//!
//! The unit tests in `library.rs` check the parsing against hand-written JSON.
//! These check that ExifTool actually *emits* that shape — the assumption those
//! tests are built on, and the one that would silently break on a version bump.
//!
//! Fixtures come from `build_tools/make_fixtures.py`.

use std::path::{Path, PathBuf};

use revery_exif_core::exiftool::ExifToolSession;
use revery_exif_core::library;

mod common;

use common::{engine, fixture_dir as source_fixtures, require_fixture};

/// A private copy of the fixture folder, made once per test run.
///
/// The read tests used to work on `test/fixtures/` in place, which meant that
/// opening the app on that folder — an obvious thing to do while trying the
/// app out — edited the very files the assertions describe, and the suite
/// started failing for reasons that had nothing to do with the code. Working
/// on a copy makes the suite independent of whatever else has touched them.
///
/// Staging now *panics* rather than falling back to the source directory. The
/// old fallback quietly turned a staging failure into "run against the
/// originals", which is the behaviour this function exists to prevent.
fn fixtures() -> PathBuf {
    use std::sync::OnceLock;
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!("revery-read-fixtures-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir)
            .unwrap_or_else(|e| panic!("cannot stage fixtures in {}: {e}", dir.display()));
        let entries = std::fs::read_dir(source_fixtures()).unwrap_or_else(|e| {
            panic!(
                "cannot read {}: {e}. The fixtures are committed to git, so this \
                 checkout is incomplete.",
                source_fixtures().display()
            )
        });
        let mut staged = 0;
        for entry in entries.flatten() {
            if entry.path().extension().is_some_and(|e| e == "jpg") {
                std::fs::copy(entry.path(), dir.join(entry.file_name()))
                    .unwrap_or_else(|e| panic!("cannot stage {:?}: {e}", entry.file_name()));
                staged += 1;
            }
        }
        assert!(staged > 0, "no JPEG fixtures found in {}", source_fixtures().display());
        dir
    })
    .clone()
}

/// See `tests/common`: a missing fixture fails, a missing engine skips.
macro_rules! session_or_skip {
    () => {{
        require_fixture("north_gps.jpg");
        match engine() {
            Some(s) => s,
            None => return,
        }
    }};
}

/// Copies the HEIC fixture too; `fixtures()` only carries the JPEGs across.
fn heic_fixture() -> PathBuf {
    let source = require_fixture("phone.heic");
    let dest = fixtures().join("phone.heic");
    if !dest.is_file() {
        std::fs::copy(&source, &dest).expect("stage phone.heic");
    }
    dest
}

fn read_one(session: &ExifToolSession, name: &str) -> serde_json::Value {
    let path = fixtures().join(name);
    let value = library::read_metadata(session, &[path]).expect("read should succeed");
    value
        .as_array()
        .and_then(|a| a.first())
        .cloned()
        .unwrap_or_else(|| panic!("no metadata returned for {name}"))
}

#[test]
fn reads_northern_hemisphere_position() {
    let s = session_or_skip!();
    let entry = read_one(&s, "north_gps.jpg");
    let position = library::position_from_metadata(&entry).expect("north_gps.jpg has GPS");
    assert!((position.latitude - 59.9139).abs() < 1e-4, "got {position:?}");
    assert!((position.longitude - 10.7522).abs() < 1e-4, "got {position:?}");
    let altitude = position.altitude.expect("altitude was written");
    assert!((altitude - 12.5).abs() < 0.1, "got {altitude}");
}

#[test]
fn reads_southern_hemisphere_position_with_the_right_sign() {
    let s = session_or_skip!();
    let entry = read_one(&s, "south_gps.jpg");
    let position = library::position_from_metadata(&entry).expect("south_gps.jpg has GPS");

    // The whole point of this fixture: EXIF stores the magnitude with a
    // separate "S"/"W", and reading that directly would move Santiago into
    // the northern hemisphere and across to the far side of the Atlantic.
    assert!(
        position.latitude < 0.0,
        "southern latitude must be negative, got {}",
        position.latitude
    );
    assert!(
        position.longitude < 0.0,
        "western longitude must be negative, got {}",
        position.longitude
    );
    assert!((position.latitude + 33.4489).abs() < 1e-4, "got {position:?}");
    assert!((position.longitude + 70.6693).abs() < 1e-4, "got {position:?}");

    // Confirm the raw EXIF value really is the unsigned magnitude, so this
    // test keeps meaning what it says if ExifTool ever changes.
    let raw = entry["EXIF:GPSLatitude"].as_f64().expect("raw latitude");
    assert!(raw > 0.0, "EXIF:GPSLatitude is expected to be unsigned");
    assert_eq!(entry["EXIF:GPSLatitudeRef"].as_str(), Some("S"));
    assert_eq!(entry["EXIF:GPSLongitudeRef"].as_str(), Some("W"));
}

/// Pins the convention discovered against the real binary: the *signed value*
/// is what sets a GPS reference tag, for altitude just as for latitude and
/// longitude. Writing the documented enum instead fails silently.
#[test]
fn writing_the_altitude_ref_as_an_enum_is_silently_wrong() {
    let s = session_or_skip!();
    let dir = std::env::temp_dir().join("revery-exif-alt-convention");
    std::fs::create_dir_all(&dir).unwrap();

    let enum_form = dir.join("enum.jpg");
    let signed_form = dir.join("signed.jpg");
    std::fs::copy(fixtures().join("no_gps.jpg"), &enum_form).unwrap();
    std::fs::copy(fixtures().join("no_gps.jpg"), &signed_form).unwrap();

    // What the tag's own documentation implies: 1 == below sea level.
    s.execute(&[
        "-overwrite_original".into(),
        "-GPSAltitude=430".into(),
        "-GPSAltitudeRef=1".into(),
        enum_form.to_string_lossy().into_owned(),
    ])
    .unwrap();

    // What this app does instead.
    s.execute(&[
        "-overwrite_original".into(),
        "-GPSAltitude=-430".into(),
        "-GPSAltitudeRef=-430".into(),
        signed_form.to_string_lossy().into_owned(),
    ])
    .unwrap();

    let read = |p: &Path| -> f64 {
        let v = library::read_metadata(&s, &[p.to_path_buf()]).unwrap();
        v[0]["Composite:GPSAltitude"].as_f64().unwrap()
    };

    // The enum form reports success and stores the wrong thing. If a future
    // ExifTool ever fixes this, the assertion fails and we can simplify.
    assert_eq!(
        read(&enum_form),
        430.0,
        "-GPSAltitudeRef=1 is expected to be silently ignored"
    );
    assert_eq!(
        read(&signed_form),
        -430.0,
        "the signed form is what actually records 'below sea level'"
    );

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn altitude_below_sea_level_reads_negative() {
    let s = session_or_skip!();
    let entry = read_one(&s, "below_sea_level.jpg");
    let position = library::position_from_metadata(&entry).expect("has GPS");
    let altitude = position.altitude.expect("has altitude");
    // GPSAltitudeRef=1 means below sea level; the composite value carries it
    // as a negative rather than leaving the caller to interpret a 0/1 flag.
    assert!(altitude < 0.0, "expected a negative altitude, got {altitude}");
    assert!((altitude + 430.0).abs() < 1.0, "got {altitude}");
}

#[test]
fn a_file_without_gps_has_no_position() {
    let s = session_or_skip!();
    let entry = read_one(&s, "no_gps.jpg");
    // Must be absent, not (0, 0) — which is a real location in the Gulf of
    // Guinea and would silently place every un-geotagged photo there.
    assert!(library::position_from_metadata(&entry).is_none());
    // Sanity: the file was read, it simply has no GPS.
    assert_eq!(entry["EXIF:Make"].as_str(), Some("Nikon"));
}

#[test]
fn reads_the_curated_fields_from_the_groups_the_ui_expects() {
    let s = session_or_skip!();
    let entry = read_one(&s, "north_gps.jpg");
    // The frontend indexes tags by "Group:Name". If -G ever stopped emitting
    // the prefix, every curated field would silently read as empty.
    assert_eq!(entry["XMP:Title"].as_str(), Some("Fjord morning"));
    assert_eq!(entry["EXIF:Artist"].as_str(), Some("Harald Revery"));
    assert_eq!(entry["EXIF:Model"].as_str(), Some("Canon EOS R6"));
    assert_eq!(
        entry["EXIF:DateTimeOriginal"].as_str(),
        Some("2024:06:15 09:41:00")
    );
    // Several keywords come back as an array; one comes back bare. The
    // frontend normalises both, but the array case must actually occur.
    let keywords = entry["XMP:Subject"].as_array().expect("two keywords -> array");
    assert_eq!(keywords.len(), 2);
}

#[test]
fn non_ascii_metadata_survives_the_round_trip() {
    let s = session_or_skip!();
    let entry = read_one(&s, "unicode.jpg");
    // -charset UTF8 on both the write and the read. Without it these come
    // back mojibake, which would then be written back and corrupt the file.
    assert_eq!(
        entry["XMP:Title"].as_str(),
        Some("Vinterlys på Sognefjorden — 冬")
    );
    assert_eq!(entry["XMP:Creator"].as_str(), Some("Håkon Ødegård"));
}

#[test]
fn reads_many_files_in_one_round_trip() {
    let s = session_or_skip!();
    let paths: Vec<PathBuf> = ["north_gps.jpg", "south_gps.jpg", "no_gps.jpg"]
        .iter()
        .map(|n| fixtures().join(n))
        .collect();
    let value = library::read_metadata(&s, &paths).expect("batch read");
    let array = value.as_array().expect("array");
    // One ExifTool call per selection, not per file — the reason the session
    // exists at all.
    assert_eq!(array.len(), 3);
    // Every entry must be attributable, or the panel cannot map results back
    // onto the files the user selected.
    for entry in array {
        assert!(entry["SourceFile"].is_string());
    }
}

#[test]
fn extracts_an_embedded_thumbnail() {
    let s = session_or_skip!();
    let path = fixtures().join("with_thumb.jpg");
    let preview = library::extract_preview(&s, &path)
        .expect("extraction should succeed")
        .expect("with_thumb.jpg has an embedded thumbnail");
    assert!(!preview.base64.is_empty());
    // Must be a decodable JPEG, not the literal "base64:" prefix left on or
    // some other tag's value: /9j/ is the base64 of the JPEG SOI marker.
    assert!(
        preview.base64.starts_with("/9j/"),
        "not a JPEG: {}",
        &preview.base64[..preview.base64.len().min(32)]
    );
}

/// An extracted preview must arrive with the rotation that applies to it.
///
/// This is the failure that looks like a rendering bug and is actually a
/// missing tag. A webview decoding a file directly reads `Orientation` out of
/// that file and applies it without being asked. Extraction hands over a bare
/// JPEG blob instead — the rotation stayed behind in the container — so unless
/// it is carried across explicitly, every portrait phone photo displays on its
/// side. At 168 px that is easy to mistake for someone having held the camera
/// oddly; at full screen it is unmistakable, which is why it surfaced only
/// once there was somewhere to show a photo large.
///
/// Pinned against the binary because the value has to survive `-n` (the number
/// 6, not "Rotate 90 CW") and the unprefixed key that comes back without `-G`.
///
/// The rotated file is **made here** rather than committed. Written against
/// the fixtures as they stand, this test passed while asserting nothing: not
/// one of them carries an `Orientation` tag, so every run took the "no tag, so
/// expect `None`" branch and would have gone on passing with the whole feature
/// deleted. A test for a value no fixture has is a test for nothing.
#[test]
fn an_extracted_preview_carries_the_parent_files_orientation() {
    let s = session_or_skip!();

    let dir = std::env::temp_dir().join(format!("revery-orient-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("scratch dir");
    let rotated = dir.join("rotated.jpg");
    let source = fixtures().join("with_thumb.jpg");
    if std::fs::copy(&source, &rotated).is_err() {
        return; // fixtures not generated
    }

    // 6 is "rotate 90 CW" — a portrait photo off a phone held sideways, which
    // is the case that makes this visible.
    let response = s
        .execute(&[
            "-overwrite_original".into(),
            "-n".into(),
            "-Orientation=6".into(),
            rotated.to_string_lossy().into_owned(),
        ])
        .expect("setting the orientation should succeed");
    assert!(!response.has_error(), "{}", response.error_text());

    let preview = library::extract_preview(&s, &rotated)
        .expect("extraction should succeed")
        .expect("the copy still has its embedded thumbnail");
    assert!(
        preview.base64.starts_with("/9j/"),
        "the orientation request disturbed the thumbnail extraction"
    );
    assert_eq!(
        preview.orientation,
        Some(6),
        "the extraction dropped the rotation the file actually carries"
    );

    // And the honest answer when there is no tag: `None`, not a defaulted 1.
    // Rotating by a guess is how a correctly-stored photo comes out wrong.
    let plain = library::extract_preview(&s, &source)
        .expect("extraction should succeed")
        .expect("with_thumb.jpg has an embedded thumbnail");
    assert_eq!(plain.orientation, None);

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_file_with_no_preview_returns_none_not_an_error() {
    let s = session_or_skip!();
    let path = fixtures().join("no_gps.jpg");
    // Legal and common. The grid shows a placeholder; it must not be treated
    // as a failure and it must not fall over.
    assert!(library::extract_preview(&s, &path).unwrap().is_none());
}

#[test]
fn scanning_the_fixture_folder_finds_every_image() {
    let entries = library::scan_folder(&fixtures()).expect("scan");
    if entries.is_empty() {
        return; // fixtures not generated
    }
    assert!(entries.iter().any(|e| e.name == "north_gps.jpg"));
    // Plain JPEGs decode in the webview, so they must not be flagged for
    // extraction — that would spend an ExifTool round trip per tile for
    // nothing.
    assert!(entries
        .iter()
        .filter(|e| e.name.ends_with(".jpg"))
        .all(|e| !e.needs_preview));
    // A HEIC is the other way round: nothing can decode it in the page, so it
    // must be flagged.
    if let Some(heic) = entries.iter().find(|e| e.name.ends_with(".heic")) {
        assert!(heic.needs_preview, "a HEIC must be flagged for extraction");
    }
}

#[test]
fn reading_a_file_outside_the_library_is_refused() {
    let root = fixtures();
    if !root.is_dir() {
        return;
    }
    // The guard is what stands between a crafted path from the frontend and
    // the rest of the disk.
    assert!(library::resolve_within(&root, "/etc/passwd").is_err());
    assert!(
        library::resolve_within(&root, root.join("../../etc/hosts").to_str().unwrap()).is_err()
    );
    let inside = root.join("north_gps.jpg");
    assert!(library::resolve_within(&root, inside.to_str().unwrap()).is_ok());
}

#[test]
fn a_missing_file_reports_an_error_rather_than_empty_metadata() {
    let s = session_or_skip!();
    let missing = fixtures().join("does-not-exist.jpg");
    // A failed request produces no stdout at all. If that were read as
    // "success, no tags", the panel would show a file as having no metadata
    // instead of saying it could not be read.
    let result = library::read_metadata(&s, &[missing]);
    assert!(result.is_err(), "expected an error, got {result:?}");
    assert!(
        result.unwrap_err().contains("File not found"),
        "error should name the cause"
    );
}

#[test]
fn a_path_that_is_a_directory_does_not_hang_the_session() {
    let s = session_or_skip!();
    // ExifTool recurses into directories with -r, and without it reports a
    // warning. Either way the session must stay usable for the next request.
    let _ = library::read_metadata(&s, &[fixtures()]);
    let entry = read_one(&s, "north_gps.jpg");
    assert_eq!(entry["XMP:Title"].as_str(), Some("Fjord morning"));
}

#[test]
fn the_engine_reports_a_version() {
    let s = session_or_skip!();
    let response = s.execute(&["-ver".into()]).expect("-ver");
    let version = response.stdout.trim();
    assert!(
        version.split('.').next().and_then(|m| m.parse::<u32>().ok()).is_some(),
        "unexpected version string: {version:?}"
    );
}

#[test]
fn locate_names_the_fix_when_exiftool_is_absent() {
    let err = ExifToolSession::locate(Path::new("/nonexistent/root")).unwrap_err();
    // A setup failure should tell the user the command that fixes it.
    assert!(err.contains("fetch_exiftool.py"), "unhelpful error: {err}");
}

/* ══════════════════════════════════════════════════════════════════════════
   HEIC — the format the webview cannot decode
══════════════════════════════════════════════════════════════════════════ */

#[test]
fn heic_metadata_reads_like_any_other_format() {
    let s = session_or_skip!();
    let path = heic_fixture();
    let value = library::read_metadata(&s, &[path]).expect("read");
    let entry = &value[0];
    assert_eq!(entry["File:FileType"].as_str(), Some("HEIC"));
    assert_eq!(entry["EXIF:Model"].as_str(), Some("iPhone 15 Pro"));
    let position = library::position_from_metadata(entry).expect("HEIC carries GPS");
    assert!((position.latitude - 59.9139).abs() < 1e-4, "got {position:?}");
    // Phones record their zone; geotagging prefers it over the user's guess.
    assert_eq!(entry["EXIF:OffsetTimeOriginal"].as_str(), Some("+02:00"));
}

/// The one that justifies the whole preview-extraction path.
///
/// No browser engine decodes HEIC, so extraction is the *only* way a phone
/// photo ever gets a thumbnail. Proving it against a JPEG proves nothing.
#[test]
fn a_heic_preview_can_be_extracted() {
    let s = session_or_skip!();
    let path = heic_fixture();
    let preview = library::extract_preview(&s, &path)
        .expect("extraction should succeed")
        .expect("phone.heic carries an EXIF thumbnail");
    // Must be a real JPEG the webview can show: /9j/ is base64 for the JPEG
    // start-of-image marker.
    assert!(
        preview.base64.starts_with("/9j/"),
        "not a JPEG: {}",
        &preview.base64[..preview.base64.len().min(24)]
    );
    assert!(preview.base64.len() > 500, "suspiciously small preview");
}

#[test]
fn a_heic_is_flagged_as_needing_extraction() {
    // The grid tries extraction first for HEIC, because the webview will fail.
    assert!(library::needs_extracted_preview(Path::new("phone.heic")));
    let path = heic_fixture();
    let entries = library::scan_folder(path.parent().unwrap()).expect("scan");
    let heic = entries.iter().find(|e| e.name == "phone.heic").expect("listed");
    assert!(heic.needs_preview);
}
