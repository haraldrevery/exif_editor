//! The write path, against the real ExifTool binary and real files.
//!
//! These are the tests Phase 2 exists for. The question they answer is not
//! "did the tag change" — it is **"did anything else change"**. An engine that
//! quietly drops MakerNotes, an ICC profile or an embedded thumbnail while
//! faithfully writing the tag you asked for is the failure mode that destroys
//! a photo library, and it is invisible unless something compares the whole
//! tag set before and after.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use revery_exif_core::exiftool::ExifToolSession;
use revery_exif_core::library::{self, GpsPosition};
use revery_exif_core::write::{self, FieldEdit, GpsEdit, PhotoEdit, TagEdit};

mod common;

use common::{engine, fixture_dir as fixtures, require_fixture};

/// The engine, or an early return when it has not been vendored.
///
/// **Only the engine may skip.** A missing fixture panics inside
/// `require_fixture`, because fixtures are committed — see `tests/common`.
macro_rules! session_or_skip {
    () => {{
        // Ordered deliberately: the fixture check runs first, so an incomplete
        // checkout fails even on a machine with no vendor tree. Reversed, a
        // fresh clone would skip past a broken checkout and report success.
        require_fixture("north_gps.jpg");
        match engine() {
            Some(s) => s,
            None => return,
        }
    }};
}

/// A scratch directory holding a copy of one fixture, removed on drop.
struct Scratch {
    dir: PathBuf,
    file: PathBuf,
}

impl Scratch {
    fn new(name: &str, fixture: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("revery-exif-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(fixture);
        std::fs::copy(fixtures().join(fixture), &file).unwrap();
        Self { dir, file }
    }

    fn bytes(&self) -> Vec<u8> {
        std::fs::read(&self.file).unwrap()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn set(value: serde_json::Value) -> FieldEdit {
    FieldEdit::Set { value }
}

fn edit_of(pairs: Vec<(&str, FieldEdit)>) -> PhotoEdit {
    let mut edit = PhotoEdit::default();
    for (k, v) in pairs {
        edit.fields.insert(k.to_string(), v);
    }
    edit
}

/// The complete tag set, flattened for comparison.
fn full_dump(session: &ExifToolSession, path: &Path) -> BTreeMap<String, String> {
    let value = library::read_metadata(session, &[path.to_path_buf()]).expect("read");
    let entry = value.get(0).expect("one entry").clone();
    entry
        .as_object()
        .expect("object")
        .iter()
        .map(|(k, v)| (k.clone(), v.to_string()))
        .collect()
}

/// Tags that legitimately differ after any write, and carry no photographic
/// meaning: filesystem timestamps, size, permissions, and ExifTool's own
/// bookkeeping. Everything else must survive untouched.
fn is_incidental(tag: &str) -> bool {
    tag.starts_with("File:")
        || tag.starts_with("ExifTool:")
        || tag == "SourceFile"
        // Directory and name move with the temp file during the write.
        || tag.starts_with("System:")
        // Pointers, not content. Inserting metadata rewrites the container, so
        // everything after the insertion point shifts and these values follow.
        // They say where a thing is, not what it is — and that a thing is still
        // *there* is asserted separately, by comparing the extracted thumbnail
        // byte for byte.
        //
        // Only visible on HEIC: JPEG's marker segments do not expose offsets
        // as tags, so this class of false positive never came up until a real
        // phone file was tested.
        || tag.ends_with("Offset")
        || tag == "QuickTime:MediaDataSize"
}

/* ══════════════════════════════════════════════════════════════════════════
   INTEGRITY — the reason Phase 2 exists
══════════════════════════════════════════════════════════════════════════ */

#[test]
fn writing_one_tag_changes_only_that_tag() {
    let s = session_or_skip!();
    let scratch = Scratch::new("integrity", "north_gps.jpg");

    let before = full_dump(&s, &scratch.file);
    assert!(before.len() > 15, "fixture should be metadata-rich");

    write::apply_edit(
        &s,
        &scratch.dir,
        scratch.file.to_str().unwrap(),
        &edit_of(vec![("copyright", set(serde_json::json!("© 2026 Harald Revery")))]),
    )
    .expect("write should succeed");

    let after = full_dump(&s, &scratch.file);

    // Everything the edit did not name must be byte-for-byte identical.
    let expected_to_change = ["XMP:Rights", "IPTC:CopyrightNotice", "EXIF:Copyright"];
    let mut unexpected = Vec::new();
    for (tag, old) in &before {
        if is_incidental(tag) || expected_to_change.contains(&tag.as_str()) {
            continue;
        }
        match after.get(tag) {
            None => unexpected.push(format!("{tag}: DROPPED (was {old})")),
            Some(new) if new != old => {
                unexpected.push(format!("{tag}: {old} -> {new}"))
            }
            _ => {}
        }
    }
    assert!(
        unexpected.is_empty(),
        "writing the copyright disturbed unrelated metadata:\n  {}",
        unexpected.join("\n  ")
    );

    // And the change itself landed, in all three standards.
    for tag in expected_to_change {
        assert!(
            after.get(tag).is_some_and(|v| v.contains("Harald Revery")),
            "{tag} was not written: {:?}",
            after.get(tag)
        );
    }
}

/// A canary for the test above.
///
/// `writing_one_tag_changes_only_that_tag` is only worth anything if it would
/// actually notice metadata loss. This performs a deliberately destructive
/// write — the exact thing a bad engine would do silently — and asserts the
/// same comparison catches it. If this ever passes quietly, the integrity
/// check has stopped comparing anything.
#[test]
fn the_integrity_check_would_notice_metadata_loss() {
    let s = session_or_skip!();
    let scratch = Scratch::new("canary", "north_gps.jpg");

    let before = full_dump(&s, &scratch.file);

    // `-all=` strips every tag: what "silently eating MakerNotes" looks like
    // taken to its conclusion.
    s.execute(&[
        "-overwrite_original".into(),
        "-all=".into(),
        scratch.file.to_string_lossy().into_owned(),
    ])
    .unwrap();

    let after = full_dump(&s, &scratch.file);
    let dropped: Vec<_> = before
        .keys()
        .filter(|tag| !is_incidental(tag) && !after.contains_key(*tag))
        .collect();

    assert!(
        !dropped.is_empty(),
        "the integrity comparison failed to notice a full metadata strip — \
         it is no longer testing anything"
    );
    // Specifically the things that matter and are easy to lose.
    assert!(
        dropped.iter().any(|t| t.contains("GPS")),
        "GPS loss went unnoticed: {dropped:?}"
    );
    assert!(
        dropped.iter().any(|t| t.starts_with("XMP:")),
        "XMP loss went unnoticed: {dropped:?}"
    );
}

#[test]
fn writing_does_not_drop_the_embedded_thumbnail() {
    let s = session_or_skip!();
    let scratch = Scratch::new("thumb", "with_thumb.jpg");

    let before = library::extract_preview(&s, &scratch.file)
        .unwrap()
        .expect("fixture has a thumbnail");

    write::apply_edit(
        &s,
        &scratch.dir,
        scratch.file.to_str().unwrap(),
        &edit_of(vec![("title", set(serde_json::json!("Still here")))]),
    )
    .expect("write");

    let after = library::extract_preview(&s, &scratch.file)
        .unwrap()
        .expect("the thumbnail must survive an unrelated edit");
    // A silently discarded thumbnail is exactly the kind of loss that only
    // shows up months later, in some other program's grid view.
    assert_eq!(before.base64, after.base64, "the thumbnail was altered");
}

#[test]
fn the_image_data_itself_is_never_touched() {
    let s = session_or_skip!();
    let scratch = Scratch::new("pixels", "north_gps.jpg");

    let before = s
        .execute(&[
            "-j".into(),
            "-ImageDataMD5".into(),
            scratch.file.to_string_lossy().into_owned(),
        ])
        .expect("hash before");

    write::apply_edit(
        &s,
        &scratch.dir,
        scratch.file.to_str().unwrap(),
        &edit_of(vec![("title", set(serde_json::json!("New title")))]),
    )
    .expect("write");

    let after = s
        .execute(&[
            "-j".into(),
            "-ImageDataMD5".into(),
            scratch.file.to_string_lossy().into_owned(),
        ])
        .expect("hash after");

    // Editing metadata must not recompress or otherwise disturb the pixels.
    // ImageDataMD5 hashes the image stream alone, ignoring all metadata.
    assert_eq!(
        before.stdout, after.stdout,
        "the image data changed during a metadata edit"
    );
}

/* ══════════════════════════════════════════════════════════════════════════
   ATOMICITY AND FAILURE
══════════════════════════════════════════════════════════════════════════ */

#[test]
fn a_failed_write_leaves_the_original_byte_identical() {
    let s = session_or_skip!();
    let scratch = Scratch::new("failed", "north_gps.jpg");
    let before = scratch.bytes();

    // An unknown field fails while building the arguments, before any copy.
    let err = write::apply_edit(
        &s,
        &scratch.dir,
        scratch.file.to_str().unwrap(),
        &edit_of(vec![("not_a_field", set(serde_json::json!("x")))]),
    )
    .unwrap_err();
    assert!(err.contains("Unknown field"), "unexpected: {err}");

    assert_eq!(
        scratch.bytes(),
        before,
        "the original must not change when a write fails"
    );
    assert_eq!(leftover_temps(&scratch.dir), 0, "a temp file was left behind");
}

#[test]
fn an_out_of_range_position_is_refused_before_anything_is_written() {
    let s = session_or_skip!();
    let scratch = Scratch::new("badgps", "no_gps.jpg");
    let before = scratch.bytes();

    let mut edit = PhotoEdit::default();
    edit.gps = Some(GpsEdit::Set {
        position: GpsPosition {
            latitude: 200.0,
            longitude: 0.0,
            altitude: None,
        },
    });
    assert!(write::apply_edit(&s, &scratch.dir, scratch.file.to_str().unwrap(), &edit).is_err());
    assert_eq!(scratch.bytes(), before);
    assert_eq!(leftover_temps(&scratch.dir), 0);
}

#[test]
fn a_write_outside_the_library_root_is_refused() {
    let s = session_or_skip!();
    let scratch = Scratch::new("escape", "no_gps.jpg");

    // The guard is what stands between a crafted path from the frontend and
    // the rest of the disk — and this one would *modify* a file, not just
    // read it. The target is a scratch copy, not a real fixture: if the guard
    // ever regresses, this test should fail without also corrupting the corpus
    // every other assertion is written against.
    let outside_dir = std::env::temp_dir().join(format!("revery-outside-{}", std::process::id()));
    std::fs::create_dir_all(&outside_dir).unwrap();
    let outside = outside_dir.join("north_gps.jpg");
    std::fs::copy(fixtures().join("north_gps.jpg"), &outside).unwrap();
    let before = std::fs::read(&outside).unwrap();

    let err = write::apply_edit(
        &s,
        &scratch.dir,
        outside.to_str().unwrap(),
        &edit_of(vec![("title", set(serde_json::json!("should not happen")))]),
    )
    .unwrap_err();
    assert!(err.contains("outside the open folder"), "unexpected: {err}");
    assert_eq!(std::fs::read(&outside).unwrap(), before, "the outside file was modified");
    std::fs::remove_dir_all(&outside_dir).ok();
}

#[test]
fn a_read_only_file_is_refused_with_a_clear_reason() {
    let s = session_or_skip!();
    let scratch = Scratch::new("readonly", "no_gps.jpg");

    let mut perms = std::fs::metadata(&scratch.file).unwrap().permissions();
    perms.set_readonly(true);
    std::fs::set_permissions(&scratch.file, perms).unwrap();

    let err = write::apply_edit(
        &s,
        &scratch.dir,
        scratch.file.to_str().unwrap(),
        &edit_of(vec![("title", set(serde_json::json!("nope")))]),
    )
    .unwrap_err();
    assert!(err.contains("read-only"), "unhelpful error: {err}");
    // Pre-flight must catch this before staging a copy.
    assert_eq!(leftover_temps(&scratch.dir), 0);

    let mut perms = std::fs::metadata(&scratch.file).unwrap().permissions();
    #[allow(clippy::permissions_set_readonly_false)]
    perms.set_readonly(false);
    std::fs::set_permissions(&scratch.file, perms).unwrap();
}

/// Simulates the state a crash between the copy and the rename leaves behind.
#[test]
fn a_crash_mid_write_leaves_the_original_intact_and_is_swept_up() {
    let s = session_or_skip!();
    let scratch = Scratch::new("crash", "north_gps.jpg");
    let original = scratch.bytes();

    // What the process would have created just before dying: a staged temp
    // sibling, fully written, never renamed.
    let temp = scratch.dir.join(".north_gps.jpg.999.123456789.revery_exif.tmp");
    std::fs::copy(&scratch.file, &temp).unwrap();
    s.execute(&[
        "-overwrite_original".into(),
        "-XMP:Title=half-finished edit".into(),
        temp.to_string_lossy().into_owned(),
    ])
    .unwrap();

    // The original is untouched: the rename never happened, and the original
    // was never opened for writing.
    assert_eq!(scratch.bytes(), original, "the original was modified");
    let entry = full_dump(&s, &scratch.file);
    assert!(
        entry["XMP:Title"].contains("Fjord morning"),
        "the original picked up the abandoned edit"
    );

    // Opening the folder cleans the stray file up rather than leaving it to
    // accumulate in the user's photo directory forever.
    assert_eq!(write::sweep_stale_temps(&scratch.dir), 1);
    assert!(!temp.exists());
    assert_eq!(scratch.bytes(), original, "sweeping disturbed the original");
}

#[test]
fn sweeping_leaves_real_photos_alone() {
    let scratch = Scratch::new("sweep", "north_gps.jpg");
    std::fs::write(scratch.dir.join("notes.txt"), b"keep me").unwrap();
    std::fs::write(scratch.dir.join(".hidden.jpg"), b"keep me too").unwrap();

    assert_eq!(write::sweep_stale_temps(&scratch.dir), 0);
    assert!(scratch.file.exists());
    assert!(scratch.dir.join("notes.txt").exists());
    assert!(scratch.dir.join(".hidden.jpg").exists());
}

fn leftover_temps(dir: &Path) -> usize {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|e| e.file_name().to_string_lossy().ends_with(".revery_exif.tmp"))
                .count()
        })
        .unwrap_or(0)
}

/* ══════════════════════════════════════════════════════════════════════════
   FIELD BEHAVIOUR
══════════════════════════════════════════════════════════════════════════ */

#[test]
fn a_value_lands_in_every_standard() {
    let s = session_or_skip!();
    let scratch = Scratch::new("fanout", "no_gps.jpg");

    write::apply_edit(
        &s,
        &scratch.dir,
        scratch.file.to_str().unwrap(),
        &edit_of(vec![("creator", set(serde_json::json!(["Harald Revery"])))]),
    )
    .expect("write");

    let dump = full_dump(&s, &scratch.file);
    // A creator written only to XMP is invisible to a great deal of software.
    assert!(dump.contains_key("XMP:Creator"), "missing XMP");
    assert!(dump.contains_key("IPTC:By-line"), "missing IPTC");
    assert!(dump.contains_key("EXIF:Artist"), "missing EXIF");
}

#[test]
fn editing_keywords_replaces_them_rather_than_appending() {
    let s = session_or_skip!();
    let scratch = Scratch::new("keywords", "north_gps.jpg");
    // The fixture starts with ["sea", "north"].

    write::apply_edit(
        &s,
        &scratch.dir,
        scratch.file.to_str().unwrap(),
        &edit_of(vec![("keywords", set(serde_json::json!(["winter"])))]),
    )
    .expect("write");

    let dump = full_dump(&s, &scratch.file);
    let subject = &dump["XMP:Subject"];
    assert!(subject.contains("winter"), "new keyword missing: {subject}");
    // Without the leading clear, ExifTool appends and the old keywords stay
    // forever — every edit growing the list.
    assert!(!subject.contains("sea"), "old keywords were kept: {subject}");
    assert!(!subject.contains("north"), "old keywords were kept: {subject}");
}

#[test]
fn clearing_a_field_removes_it_from_every_standard() {
    let s = session_or_skip!();
    let scratch = Scratch::new("clear", "north_gps.jpg");

    write::apply_edit(
        &s,
        &scratch.dir,
        scratch.file.to_str().unwrap(),
        &edit_of(vec![("title", FieldEdit::Clear)]),
    )
    .expect("write");

    let dump = full_dump(&s, &scratch.file);
    assert!(!dump.contains_key("XMP:Title"), "XMP title survived");
    assert!(!dump.contains_key("IPTC:ObjectName"), "IPTC title survived");
    // Clearing one field must not disturb its neighbours.
    assert!(dump.contains_key("EXIF:Artist"), "an unrelated field was cleared");
}

#[test]
fn clearing_the_location_removes_it_from_xmp_as_well_as_exif() {
    let s = session_or_skip!();
    let scratch = Scratch::new("gpsclear", "north_gps.jpg");

    // Give the file XMP GPS as well, which is what a phone or Lightroom
    // export commonly leaves alongside the EXIF block.
    s.execute(&[
        "-overwrite_original".into(),
        "-XMP:GPSLatitude=59.9139".into(),
        "-XMP:GPSLongitude=10.7522".into(),
        scratch.file.to_string_lossy().into_owned(),
    ])
    .unwrap();
    assert!(full_dump(&s, &scratch.file).contains_key("XMP:GPSLatitude"));

    let mut edit = PhotoEdit::default();
    edit.gps = Some(GpsEdit::Clear);
    write::apply_edit(&s, &scratch.dir, scratch.file.to_str().unwrap(), &edit).expect("write");

    let dump = full_dump(&s, &scratch.file);
    // This is a privacy guarantee, not a tidiness one: someone stripping
    // location before publishing must not still be shipping coordinates.
    // `-gps:all=` leaves the XMP copy behind, which is why the code uses
    // `-GPS*=`.
    let remaining: Vec<_> = dump.keys().filter(|k| k.contains("GPS")).collect();
    assert!(remaining.is_empty(), "location survived in: {remaining:?}");
    assert!(library::position_from_metadata(
        &library::read_metadata(&s, &[scratch.file.clone()]).unwrap()[0]
    )
    .is_none());
}

#[test]
fn a_written_position_round_trips_with_its_hemisphere() {
    let s = session_or_skip!();
    let scratch = Scratch::new("gpsset", "no_gps.jpg");

    // Santiago: southern *and* western, so both signs must survive.
    let santiago = GpsPosition {
        latitude: -33.4489,
        longitude: -70.6693,
        altitude: Some(570.0),
    };
    let mut edit = PhotoEdit::default();
    edit.gps = Some(GpsEdit::Set { position: santiago });
    write::apply_edit(&s, &scratch.dir, scratch.file.to_str().unwrap(), &edit).expect("write");

    let entry = library::read_metadata(&s, &[scratch.file.clone()]).unwrap()[0].clone();
    let read = library::position_from_metadata(&entry).expect("position");
    assert!((read.latitude + 33.4489).abs() < 1e-4, "got {read:?}");
    assert!((read.longitude + 70.6693).abs() < 1e-4, "got {read:?}");
    assert_eq!(entry["EXIF:GPSLatitudeRef"].as_str(), Some("S"));
    assert_eq!(entry["EXIF:GPSLongitudeRef"].as_str(), Some("W"));
}

#[test]
fn a_below_sea_level_altitude_round_trips_negative() {
    let s = session_or_skip!();
    let scratch = Scratch::new("altitude", "no_gps.jpg");

    let mut edit = PhotoEdit::default();
    edit.gps = Some(GpsEdit::Set {
        position: GpsPosition {
            latitude: 31.5,
            longitude: 35.5,
            altitude: Some(-430.0),
        },
    });
    write::apply_edit(&s, &scratch.dir, scratch.file.to_str().unwrap(), &edit).expect("write");

    let entry = library::read_metadata(&s, &[scratch.file.clone()]).unwrap()[0].clone();
    let read = library::position_from_metadata(&entry).expect("position");
    let altitude = read.altitude.expect("altitude");
    // The enum form of the reference is silently ignored by ExifTool, so this
    // is the assertion that catches a regression back to it.
    assert!(altitude < 0.0, "expected below sea level, got {altitude}");
    assert!((altitude + 430.0).abs() < 1.0, "got {altitude}");
}

#[test]
fn non_ascii_survives_a_write() {
    let s = session_or_skip!();
    let scratch = Scratch::new("unicode", "no_gps.jpg");

    let text = "Vinterlys på Sognefjorden — 冬";
    write::apply_edit(
        &s,
        &scratch.dir,
        scratch.file.to_str().unwrap(),
        &edit_of(vec![("title", set(serde_json::json!(text)))]),
    )
    .expect("write");

    let dump = full_dump(&s, &scratch.file);
    // Mojibake here would be written back into the file on the next edit,
    // compounding until the value is unrecoverable.
    assert!(dump["XMP:Title"].contains("Sognefjorden"), "got {}", dump["XMP:Title"]);
    assert!(dump["XMP:Title"].contains('冬'), "got {}", dump["XMP:Title"]);
    assert!(dump["XMP:Title"].contains('å'), "got {}", dump["XMP:Title"]);
}

#[test]
fn a_value_containing_a_newline_is_refused() {
    let s = session_or_skip!();
    let scratch = Scratch::new("newline", "no_gps.jpg");
    let before = scratch.bytes();

    // ExifTool's argument stream is line-delimited, so an embedded newline
    // would be read as the start of a new argument — turning a caption into
    // an arbitrary command against the file.
    let err = write::apply_edit(
        &s,
        &scratch.dir,
        scratch.file.to_str().unwrap(),
        &edit_of(vec![(
            "description",
            set(serde_json::json!("caption\n-delete_original!")),
        )]),
    )
    .unwrap_err();
    assert!(err.contains("line break"), "unexpected: {err}");
    assert_eq!(scratch.bytes(), before, "the file was modified");
}

#[test]
fn several_fields_apply_in_one_pass() {
    let s = session_or_skip!();
    let scratch = Scratch::new("multi", "no_gps.jpg");

    let mut edit = edit_of(vec![
        ("title", set(serde_json::json!("Fjord"))),
        ("copyright", set(serde_json::json!("© 2026"))),
        ("rating", set(serde_json::json!(4))),
    ]);
    edit.gps = Some(GpsEdit::Set {
        position: GpsPosition {
            latitude: 59.9139,
            longitude: 10.7522,
            altitude: None,
        },
    });

    write::apply_edit(&s, &scratch.dir, scratch.file.to_str().unwrap(), &edit).expect("write");

    let dump = full_dump(&s, &scratch.file);
    assert!(dump["XMP:Title"].contains("Fjord"));
    assert!(dump["XMP:Rights"].contains("2026"));
    assert_eq!(dump["XMP:Rating"], "4");
    assert!(dump.contains_key("EXIF:GPSLatitude"));
}

#[test]
fn an_empty_edit_is_a_no_op_that_does_not_rewrite_the_file() {
    let s = session_or_skip!();
    let scratch = Scratch::new("noop", "north_gps.jpg");
    let before = scratch.bytes();

    write::apply_edit(
        &s,
        &scratch.dir,
        scratch.file.to_str().unwrap(),
        &PhotoEdit::default(),
    )
    .expect("an empty edit should succeed");

    // Not merely "equivalent metadata" — the file must not be touched at all,
    // so an accidental Apply with nothing changed cannot cost anything.
    assert_eq!(scratch.bytes(), before);
}

/// The contract between `buildEdit` in `www/js/state.js` and `PhotoEdit` here.
///
/// This JSON is verbatim output from the frontend function, not a hand-written
/// approximation. The two sides are in different languages with no shared
/// schema, so nothing else would catch a rename on one side of the boundary —
/// the edit would simply deserialise into fewer fields and silently write less
/// than the user asked for.
#[test]
fn the_frontends_json_deserialises_and_applies() {
    let s = session_or_skip!();
    let scratch = Scratch::new("contract", "no_gps.jpg");

    let json = serde_json::json!({
      "title":     { "op": "set",   "value": "Fjord morning" },
      "copyright": { "op": "clear" },
      "keywords":  { "op": "set",   "value": ["sea", "north"] },
      "rating":    { "op": "set",   "value": "4" },
      "gps": {
        "op": "set",
        "position": { "latitude": -33.4489, "longitude": -70.6693 }
      }
    });

    let edit: PhotoEdit =
        serde_json::from_value(json).expect("the frontend's shape must deserialise");
    // Four fields plus the position — nothing silently dropped on the way in.
    assert_eq!(edit.fields.len(), 4, "fields lost in deserialisation");
    assert!(edit.gps.is_some());

    write::apply_edit(&s, &scratch.dir, scratch.file.to_str().unwrap(), &edit)
        .expect("the frontend's edit must apply");

    let dump = full_dump(&s, &scratch.file);
    assert!(dump["XMP:Title"].contains("Fjord morning"));
    assert!(dump["XMP:Subject"].contains("sea"));
    // Rating arrives as the string "4" from a text input; it must still land
    // as a usable rating rather than being rejected for not being a number.
    assert_eq!(dump["XMP:Rating"], "4");
    let position = library::position_from_metadata(
        &library::read_metadata(&s, &[scratch.file.clone()]).unwrap()[0],
    )
    .expect("position");
    assert!(position.latitude < 0.0 && position.longitude < 0.0);
}

#[test]
fn the_edited_file_is_still_a_readable_image() {
    let s = session_or_skip!();
    let scratch = Scratch::new("valid", "with_thumb.jpg");

    write::apply_edit(
        &s,
        &scratch.dir,
        scratch.file.to_str().unwrap(),
        &edit_of(vec![("title", set(serde_json::json!("After")))]),
    )
    .expect("write");

    let dump = full_dump(&s, &scratch.file);
    // If the write corrupted the container, these would be missing or wrong.
    assert_eq!(dump.get("File:FileType").map(String::as_str), Some("\"JPEG\""));
    assert!(dump.contains_key("File:ImageWidth"));
    assert!(
        !dump.keys().any(|k| k.contains("Error")),
        "the file reports an error after editing: {dump:?}"
    );
}

/* ══════════════════════════════════════════════════════════════════════════
   BATCHES
══════════════════════════════════════════════════════════════════════════ */

/// A scratch directory holding several fixture copies.
struct Batch {
    dir: PathBuf,
    files: Vec<PathBuf>,
}

impl Batch {
    fn new(name: &str, fixtures_wanted: &[&str]) -> Self {
        let dir = std::env::temp_dir().join(format!("revery-batch-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let files = fixtures_wanted
            .iter()
            .enumerate()
            .map(|(i, fixture)| {
                let dest = dir.join(format!("{i:02}-{fixture}"));
                std::fs::copy(fixtures().join(fixture), &dest).unwrap();
                dest
            })
            .collect();
        Self { dir, files }
    }

    fn paths(&self) -> Vec<String> {
        self.files
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect()
    }
}

impl Drop for Batch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn a_batch_applies_one_edit_to_every_file() {
    let s = session_or_skip!();
    let batch = Batch::new("apply", &["no_gps.jpg", "north_gps.jpg", "unicode.jpg"]);

    let outcome = write::apply_batch(
        &s,
        &batch.dir,
        &batch.paths(),
        &edit_of(vec![("copyright", set(serde_json::json!("© 2026 Harald Revery")))]),
    )
    .expect("batch");

    assert_eq!(outcome.succeeded, 3);
    assert_eq!(outcome.failed, 0);
    for file in &batch.files {
        let dump = full_dump(&s, file);
        assert!(
            dump["XMP:Rights"].contains("Harald Revery"),
            "{} was not written",
            file.display()
        );
    }
}

#[test]
fn a_batch_leaves_each_files_other_metadata_alone() {
    let s = session_or_skip!();
    let batch = Batch::new("preserve", &["north_gps.jpg", "unicode.jpg"]);

    let before: Vec<_> = batch.files.iter().map(|f| full_dump(&s, f)).collect();

    write::apply_batch(
        &s,
        &batch.dir,
        &batch.paths(),
        &edit_of(vec![("rating", set(serde_json::json!(5)))]),
    )
    .expect("batch");

    for (file, old) in batch.files.iter().zip(&before) {
        let new = full_dump(&s, file);
        // Each file keeps its *own* values — a batch must not homogenise the
        // selection by carrying one file's metadata onto the others.
        for (tag, value) in old {
            if is_incidental(tag) || tag == "XMP:Rating" {
                continue;
            }
            assert_eq!(
                new.get(tag),
                Some(value),
                "{} changed {tag} during a batch that only set the rating",
                file.display()
            );
        }
    }
    // And the titles are still different from each other.
    let titles: Vec<_> = batch
        .files
        .iter()
        .map(|f| full_dump(&s, f).get("XMP:Title").cloned().unwrap_or_default())
        .collect();
    assert_ne!(titles[0], titles[1], "the batch homogenised the selection");
}

#[test]
fn a_batch_refuses_before_writing_anything_if_one_file_cannot_be_written() {
    let s = session_or_skip!();
    let batch = Batch::new("preflight", &["no_gps.jpg", "north_gps.jpg", "unicode.jpg"]);
    let before: Vec<_> = batch.files.iter().map(|f| std::fs::read(f).unwrap()).collect();

    // The *last* file is read-only. A naive implementation would happily
    // rewrite the first two and only then discover the problem.
    let victim = &batch.files[2];
    let mut perms = std::fs::metadata(victim).unwrap().permissions();
    perms.set_readonly(true);
    std::fs::set_permissions(victim, perms).unwrap();

    let err = write::apply_batch(
        &s,
        &batch.dir,
        &batch.paths(),
        &edit_of(vec![("title", set(serde_json::json!("should not land")))]),
    )
    .unwrap_err();
    assert!(err.contains("read-only"), "unexpected: {err}");
    assert!(err.contains("Nothing has been changed"), "unclear: {err}");

    for (file, original) in batch.files.iter().zip(&before) {
        assert_eq!(
            &std::fs::read(file).unwrap(),
            original,
            "{} was modified despite the batch being refused",
            file.display()
        );
    }

    let mut perms = std::fs::metadata(victim).unwrap().permissions();
    #[allow(clippy::permissions_set_readonly_false)]
    perms.set_readonly(false);
    std::fs::set_permissions(victim, perms).unwrap();
}

#[test]
fn a_missing_file_stops_the_batch_before_it_starts() {
    let s = session_or_skip!();
    let batch = Batch::new("ghost", &["no_gps.jpg", "north_gps.jpg"]);
    let mut paths = batch.paths();
    paths.push(batch.dir.join("ghost.jpg").to_string_lossy().into_owned());

    let err = write::apply_batch(
        &s,
        &batch.dir,
        &paths,
        &edit_of(vec![("title", set(serde_json::json!("x")))]),
    )
    .unwrap_err();
    assert!(err.contains("ghost.jpg") || err.contains("Cannot resolve"), "{err}");

    // Pre-flight resolves every path first, so the real files are untouched.
    for file in &batch.files {
        assert!(full_dump(&s, file).get("XMP:Title").is_none_or(|t| !t.contains('x')));
    }
}

/// A batch where some files succeed and some fail.
///
/// The failure has to happen in the *writing* pass, not pre-flight, or this
/// only re-tests pre-flight. A corrupt file with a valid extension does it:
/// it exists, it is writable, and its metadata is readable enough to pass the
/// checks — but ExifTool cannot write to it. A truncated download sitting in a
/// photo folder is exactly this.
#[test]
fn a_partly_failing_batch_reports_which_files_failed() {
    let s = session_or_skip!();
    let batch = Batch::new("mixed", &["no_gps.jpg", "north_gps.jpg"]);

    let corrupt = batch.dir.join("truncated.jpg");
    std::fs::write(&corrupt, b"this is not a JPEG at all, just bytes").unwrap();

    let mut paths = batch.paths();
    paths.push(corrupt.to_string_lossy().into_owned());

    let outcome = write::apply_batch(
        &s,
        &batch.dir,
        &paths,
        &edit_of(vec![("title", set(serde_json::json!("Batch title")))]),
    )
    .expect("the batch itself should complete");

    // The headline numbers must not round either way: reporting this as
    // "failed" would hide the two files that did change, and reporting it as
    // "succeeded" would hide the one that did not.
    assert_eq!(outcome.succeeded, 2, "results: {:?}", outcome.results);
    assert_eq!(outcome.failed, 1, "results: {:?}", outcome.results);
    assert_eq!(outcome.results.len(), 3);

    let failed: Vec<_> = outcome.results.iter().filter(|r| !r.ok).collect();
    assert_eq!(failed.len(), 1);
    // The user has to be able to tell *which* file, by name, and why.
    assert!(failed[0].path.contains("truncated.jpg"), "{:?}", failed[0]);
    assert!(failed[0].error.is_some(), "no reason given: {:?}", failed[0]);

    // The good files really were written.
    for file in &batch.files {
        assert!(
            full_dump(&s, file)["XMP:Title"].contains("Batch title"),
            "{} was not written",
            file.display()
        );
    }
    // And the failure left no debris behind.
    let temps = std::fs::read_dir(&batch.dir)
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".revery_exif.tmp"))
        .count();
    assert_eq!(temps, 0, "a temp file was left behind by the failed write");
}

#[test]
fn a_partly_failing_batch_can_still_be_undone() {
    let s = session_or_skip!();
    let batch = Batch::new("mixedundo", &["no_gps.jpg", "north_gps.jpg"]);
    let before: Vec<_> = batch.files.iter().map(|f| std::fs::read(f).unwrap()).collect();

    let corrupt = batch.dir.join("truncated.jpg");
    std::fs::write(&corrupt, b"not a JPEG").unwrap();
    let mut paths = batch.paths();
    paths.push(corrupt.to_string_lossy().into_owned());

    let outcome = write::apply_batch(
        &s,
        &batch.dir,
        &paths,
        &edit_of(vec![("title", set(serde_json::json!("Oops")))]),
    )
    .expect("batch");
    assert_eq!(outcome.failed, 1);

    // A batch that went partly wrong is precisely when undo matters most.
    let undone = revery_exif_core::undo::undo_last(&batch.dir).expect("undo");
    assert!(undone.restored >= 2, "restored {} files", undone.restored);

    for (file, original) in batch.files.iter().zip(&before) {
        assert_eq!(
            &std::fs::read(file).unwrap(),
            original,
            "{} was not restored",
            file.display()
        );
    }
}

#[test]
fn an_empty_selection_is_refused() {
    let s = session_or_skip!();
    let batch = Batch::new("emptysel", &["no_gps.jpg"]);
    let err = write::apply_batch(
        &s,
        &batch.dir,
        &[],
        &edit_of(vec![("title", set(serde_json::json!("x")))]),
    )
    .unwrap_err();
    assert!(err.contains("No photos"), "unexpected: {err}");
}

#[test]
fn a_batch_with_nothing_to_change_is_refused_rather_than_rewriting_files() {
    let s = session_or_skip!();
    let batch = Batch::new("nochange", &["no_gps.jpg"]);
    let before = std::fs::read(&batch.files[0]).unwrap();

    let err = write::apply_batch(&s, &batch.dir, &batch.paths(), &PhotoEdit::default())
        .unwrap_err();
    assert!(err.contains("no changes"), "unexpected: {err}");
    assert_eq!(std::fs::read(&batch.files[0]).unwrap(), before);
}

/* ── Undo ────────────────────────────────────────────────────────────────── */

#[test]
fn undoing_a_batch_restores_every_file_byte_for_byte() {
    let s = session_or_skip!();
    let batch = Batch::new("undo", &["no_gps.jpg", "north_gps.jpg", "unicode.jpg"]);
    let before: Vec<_> = batch.files.iter().map(|f| std::fs::read(f).unwrap()).collect();

    let outcome = write::apply_batch(
        &s,
        &batch.dir,
        &batch.paths(),
        &edit_of(vec![("copyright", set(serde_json::json!("© wrong")))]),
    )
    .expect("batch");
    assert_eq!(outcome.succeeded, 3);
    assert!(
        outcome.undo_unavailable.is_none(),
        "undo should be offered: {:?}",
        outcome.undo_unavailable
    );

    // The edit landed.
    for file in &batch.files {
        assert!(full_dump(&s, file)["XMP:Rights"].contains("wrong"));
    }

    let undone = revery_exif_core::undo::undo_last(&batch.dir).expect("undo");
    assert_eq!(undone.restored, 3);
    assert!(undone.failed.is_empty(), "{:?}", undone.failed);

    // Byte-identical, not merely "equivalent metadata".
    for (file, original) in batch.files.iter().zip(&before) {
        assert_eq!(
            &std::fs::read(file).unwrap(),
            original,
            "{} was not restored exactly",
            file.display()
        );
    }
}

#[test]
fn the_undo_store_is_not_listed_as_photos() {
    let s = session_or_skip!();
    let batch = Batch::new("hidden", &["no_gps.jpg"]);

    write::apply_batch(
        &s,
        &batch.dir,
        &batch.paths(),
        &edit_of(vec![("title", set(serde_json::json!("x")))]),
    )
    .expect("batch");

    // The snapshots are copies of real photos sitting in a subdirectory of the
    // library. They must never appear in the grid, or the user would see
    // duplicates and could select and edit them.
    let listed = library::scan_folder(&batch.dir).expect("scan");
    assert_eq!(listed.len(), 1, "the undo store leaked into the listing");
    assert!(revery_exif_core::undo::is_available(&batch.dir));
}

#[test]
fn opening_a_folder_discards_an_undo_store_from_a_previous_session() {
    let s = session_or_skip!();
    let batch = Batch::new("stale", &["no_gps.jpg"]);

    write::apply_batch(
        &s,
        &batch.dir,
        &batch.paths(),
        &edit_of(vec![("title", set(serde_json::json!("x")))]),
    )
    .expect("batch");
    assert!(revery_exif_core::undo::is_available(&batch.dir));

    // Undo is a within-session promise; after a restart the snapshots are just
    // hidden files consuming space.
    assert!(revery_exif_core::undo::sweep(&batch.dir));
    assert!(!revery_exif_core::undo::is_available(&batch.dir));
    // Sweeping must not touch the photos.
    assert!(batch.files[0].exists());
    assert!(full_dump(&s, &batch.files[0])["XMP:Title"].contains('x'));
}

/* ══════════════════════════════════════════════════════════════════════════
   DATE SHIFT AND STRIPPING
══════════════════════════════════════════════════════════════════════════ */

fn shifted(seconds: i64) -> PhotoEdit {
    let mut edit = PhotoEdit::default();
    edit.dates = Some(revery_exif_core::write::DateEdit::Shift { seconds });
    edit
}

#[test]
fn a_date_shift_moves_every_timestamp_by_the_same_amount() {
    let s = session_or_skip!();
    let scratch = Scratch::new("shift", "north_gps.jpg");
    // Give CreateDate a value five seconds off DateTimeOriginal, as a camera
    // that writes both slightly apart would.
    s.execute(&[
        "-overwrite_original".into(),
        "-EXIF:CreateDate=2024:06:15 09:41:05".into(),
        scratch.file.to_string_lossy().into_owned(),
    ])
    .unwrap();

    write::apply_edit(&s, &scratch.dir, scratch.file.to_str().unwrap(), &shifted(3 * 3600))
        .expect("shift");

    let dump = full_dump(&s, &scratch.file);
    assert!(dump["EXIF:DateTimeOriginal"].contains("2024:06:15 12:41:00"));
    // The five-second gap must survive: each tag moves by its own value, not
    // all of them to one shared timestamp.
    assert!(
        dump["EXIF:CreateDate"].contains("2024:06:15 12:41:05"),
        "CreateDate collapsed onto DateTimeOriginal: {}",
        dump["EXIF:CreateDate"]
    );
}

#[test]
fn a_negative_shift_crosses_midnight_backwards() {
    let s = session_or_skip!();
    let scratch = Scratch::new("shiftback", "north_gps.jpg");
    s.execute(&[
        "-overwrite_original".into(),
        "-AllDates=2024:06:15 01:30:00".into(),
        scratch.file.to_string_lossy().into_owned(),
    ])
    .unwrap();

    write::apply_edit(&s, &scratch.dir, scratch.file.to_str().unwrap(), &shifted(-3 * 3600))
        .expect("shift");

    // The previous day, not 22:30 on the same one.
    assert!(
        full_dump(&s, &scratch.file)["EXIF:DateTimeOriginal"].contains("2024:06:14 22:30:00"),
        "got {}",
        full_dump(&s, &scratch.file)["EXIF:DateTimeOriginal"]
    );
}

#[test]
fn a_date_shift_leaves_the_rest_of_the_metadata_alone() {
    let s = session_or_skip!();
    let scratch = Scratch::new("shiftonly", "north_gps.jpg");
    let before = full_dump(&s, &scratch.file);

    write::apply_edit(&s, &scratch.dir, scratch.file.to_str().unwrap(), &shifted(3600))
        .expect("shift");

    let after = full_dump(&s, &scratch.file);
    for (tag, old) in &before {
        if is_incidental(tag) || tag.contains("Date") || tag.contains("Time") {
            continue;
        }
        assert_eq!(after.get(tag), Some(old), "{tag} changed during a date shift");
    }
}

#[test]
fn a_zero_shift_is_refused_rather_than_rewriting_files() {
    let s = session_or_skip!();
    let scratch = Scratch::new("shiftzero", "north_gps.jpg");
    let before = scratch.bytes();
    // Nothing to do; the file must not be touched at all.
    assert!(write::apply_edit(&s, &scratch.dir, scratch.file.to_str().unwrap(), &shifted(0)).is_err());
    assert_eq!(scratch.bytes(), before);
}

fn stripping(what: revery_exif_core::write::StripEdit) -> PhotoEdit {
    let mut edit = PhotoEdit::default();
    edit.strip = Some(what);
    edit
}

#[test]
fn stripping_the_location_leaves_everything_else() {
    use revery_exif_core::write::StripEdit;
    let s = session_or_skip!();
    let scratch = Scratch::new("striploc", "north_gps.jpg");

    write::apply_edit(
        &s,
        &scratch.dir,
        scratch.file.to_str().unwrap(),
        &stripping(StripEdit::Location),
    )
    .expect("strip");

    let dump = full_dump(&s, &scratch.file);
    let gps: Vec<_> = dump.keys().filter(|k| k.contains("GPS")).collect();
    assert!(gps.is_empty(), "location survived: {gps:?}");
    // The point of the narrow option: publishing without coordinates, but
    // keeping the credit and the caption.
    assert!(dump["XMP:Title"].contains("Fjord morning"));
    assert!(dump.contains_key("EXIF:Artist"));
    assert!(dump.contains_key("EXIF:Model"));
}

#[test]
fn stripping_everything_keeps_the_photo_displayable() {
    use revery_exif_core::write::StripEdit;
    let s = session_or_skip!();
    let scratch = Scratch::new("stripall", "north_gps.jpg");
    // A portrait orientation flag, which a viewer needs to show the photo the
    // right way up.
    s.execute(&[
        "-overwrite_original".into(),
        "-EXIF:Orientation#=6".into(),
        scratch.file.to_string_lossy().into_owned(),
    ])
    .unwrap();

    write::apply_edit(
        &s,
        &scratch.dir,
        scratch.file.to_str().unwrap(),
        &stripping(StripEdit::Everything),
    )
    .expect("strip");

    let dump = full_dump(&s, &scratch.file);
    // Identifying metadata is gone.
    assert!(!dump.contains_key("XMP:Title"), "title survived");
    assert!(!dump.contains_key("EXIF:Artist"), "artist survived");
    assert!(!dump.contains_key("EXIF:Model"), "camera model survived");
    assert!(
        dump.keys().all(|k| !k.contains("GPS")),
        "location survived a full strip"
    );
    // But orientation is kept, or the photo comes out sideways in every
    // viewer — a naive `-all=` destroys it.
    assert!(
        dump.contains_key("EXIF:Orientation"),
        "orientation was destroyed; the photo will display rotated"
    );
}

#[test]
fn stripping_does_not_touch_the_image_data() {
    use revery_exif_core::write::StripEdit;
    let s = session_or_skip!();
    let scratch = Scratch::new("striphash", "north_gps.jpg");
    let hash = |p: &Path| {
        s.execute(&[
            "-j".into(),
            "-ImageDataMD5".into(),
            p.to_string_lossy().into_owned(),
        ])
        .unwrap()
        .stdout
    };
    let before = hash(&scratch.file);

    write::apply_edit(
        &s,
        &scratch.dir,
        scratch.file.to_str().unwrap(),
        &stripping(StripEdit::Everything),
    )
    .expect("strip");

    // Stripping metadata must not recompress the picture.
    assert_eq!(before, hash(&scratch.file), "the image data changed");
}

#[test]
fn stripping_a_whole_selection_reports_per_file() {
    use revery_exif_core::write::StripEdit;
    let s = session_or_skip!();
    let batch = Batch::new("stripbatch", &["north_gps.jpg", "south_gps.jpg", "unicode.jpg"]);

    let outcome = write::apply_batch(
        &s,
        &batch.dir,
        &batch.paths(),
        &stripping(StripEdit::Location),
    )
    .expect("batch strip");
    assert_eq!(outcome.succeeded, 3);

    for file in &batch.files {
        assert!(
            full_dump(&s, file).keys().all(|k| !k.contains("GPS")),
            "{} kept its location",
            file.display()
        );
    }
}

/* ══════════════════════════════════════════════════════════════════════════
   HEIC — a different container, same guarantees
══════════════════════════════════════════════════════════════════════════ */

/// HEIC is an ISO-BMFF container, nothing like JPEG's marker segments. The
/// write path is format-agnostic because ExifTool is, but "because ExifTool is"
/// is an assumption, and this is the format where a broken write would hurt
/// most — it is what phones produce.
fn heic_scratch(name: &str) -> Option<Scratch> {
    // Committed like every other fixture, so its absence is a broken checkout
    // rather than something to skip past.
    require_fixture("phone.heic");
    Some(Scratch::new(name, "phone.heic"))
}

#[test]
fn writing_to_a_heic_changes_only_the_tag_asked_for() {
    let s = session_or_skip!();
    let Some(scratch) = heic_scratch("heicintegrity") else { return };

    let before = full_dump(&s, &scratch.file);
    assert!(before.len() > 15, "fixture should be metadata-rich");

    write::apply_edit(
        &s,
        &scratch.dir,
        scratch.file.to_str().unwrap(),
        &edit_of(vec![("title", set(serde_json::json!("Shot on a phone")))]),
    )
    .expect("write to HEIC should succeed");

    let after = full_dump(&s, &scratch.file);
    let expected = ["XMP:Title", "IPTC:ObjectName"];
    let mut unexpected = Vec::new();
    for (tag, old) in &before {
        if is_incidental(tag) || expected.contains(&tag.as_str()) {
            continue;
        }
        match after.get(tag) {
            None => unexpected.push(format!("{tag}: DROPPED (was {old})")),
            Some(new) if new != old => unexpected.push(format!("{tag}: {old} -> {new}")),
            _ => {}
        }
    }
    assert!(
        unexpected.is_empty(),
        "writing a title to a HEIC disturbed:\n  {}",
        unexpected.join("\n  ")
    );
    assert!(after["XMP:Title"].contains("Shot on a phone"));
    // Still a HEIC, not silently rewritten as something else.
    assert_eq!(after.get("File:FileType").map(String::as_str), Some("\"HEIC\""));
}

#[test]
fn a_heic_keeps_its_extractable_preview_through_a_write() {
    let s = session_or_skip!();
    let Some(scratch) = heic_scratch("heicthumb") else { return };

    let before = library::extract_preview(&s, &scratch.file)
        .unwrap()
        .expect("fixture has a preview");

    write::apply_edit(
        &s,
        &scratch.dir,
        scratch.file.to_str().unwrap(),
        &edit_of(vec![("copyright", set(serde_json::json!("© 2026")))]),
    )
    .expect("write");

    let after = library::extract_preview(&s, &scratch.file)
        .unwrap()
        .expect("the preview must survive an edit");
    // Lose this and every phone photo in the grid turns into a grey box after
    // the first edit — the kind of damage nobody notices until much later.
    assert_eq!(before.base64, after.base64, "the HEIC preview was altered");
}

#[test]
fn a_position_written_to_a_heic_round_trips() {
    let s = session_or_skip!();
    let Some(scratch) = heic_scratch("heicgps") else { return };

    let mut edit = PhotoEdit::default();
    edit.gps = Some(GpsEdit::Set {
        position: GpsPosition {
            latitude: -33.4489,
            longitude: -70.6693,
            altitude: None,
        },
    });
    write::apply_edit(&s, &scratch.dir, scratch.file.to_str().unwrap(), &edit).expect("write");

    let entry = library::read_metadata(&s, &[scratch.file.clone()]).unwrap()[0].clone();
    let read = library::position_from_metadata(&entry).expect("position");
    assert!(read.latitude < 0.0 && read.longitude < 0.0, "got {read:?}");
    assert_eq!(entry["EXIF:GPSLatitudeRef"].as_str(), Some("S"));
}

#[test]
fn stripping_a_heic_removes_the_phone_identifiers() {
    use revery_exif_core::write::StripEdit;
    let s = session_or_skip!();
    let Some(scratch) = heic_scratch("heicstrip") else { return };

    write::apply_edit(
        &s,
        &scratch.dir,
        scratch.file.to_str().unwrap(),
        &stripping(StripEdit::Everything),
    )
    .expect("strip");

    let dump = full_dump(&s, &scratch.file);
    // The realistic privacy case: a photo straight off a phone, published.
    assert!(!dump.contains_key("EXIF:Model"), "the phone model survived");
    assert!(!dump.contains_key("EXIF:Make"), "the make survived");
    assert!(dump.keys().all(|k| !k.contains("GPS")), "location survived");
    assert_eq!(dump.get("File:FileType").map(String::as_str), Some("\"HEIC\""));
}

#[test]
fn a_heic_write_can_be_undone() {
    let s = session_or_skip!();
    let Some(scratch) = heic_scratch("heicundo") else { return };
    let before = scratch.bytes();

    write::apply_batch(
        &s,
        &scratch.dir,
        &[scratch.file.to_string_lossy().into_owned()],
        &edit_of(vec![("title", set(serde_json::json!("Oops")))]),
    )
    .expect("write");
    assert_ne!(scratch.bytes(), before, "the write should have changed the file");

    let undone = revery_exif_core::undo::undo_last(&scratch.dir).expect("undo");
    assert_eq!(undone.restored, 1);
    assert_eq!(scratch.bytes(), before, "the HEIC was not restored exactly");
}

/* ══════════════════════════════════════════════════════════════════════════
   ARBITRARY TAGS — the All tab's edit and clear

   The unit tests pin the arguments. These pin what the binary actually does
   with them, which is the only place the print-conversion hazard is visible.
══════════════════════════════════════════════════════════════════════════ */

fn tag_edit_of(pairs: Vec<(&str, TagEdit)>) -> PhotoEdit {
    let mut edit = PhotoEdit::default();
    for (tag, e) in pairs {
        edit.tags.insert(tag.to_string(), e);
    }
    edit
}

/// Why every raw write carries `#`, demonstrated against the real binary.
///
/// `Flash` is stored as a bitmask and *displayed* as prose, so it separates
/// the two forms completely — and the failure is quiet in exactly the way that
/// matters: ExifTool answers the bare form with a **Warning**, not an Error,
/// so `has_error()` is false and the write path would sail past its own
/// error check. Only verification would catch it, and only because the tag
/// never changed. With `#` the value lands.
#[test]
fn a_raw_numeric_tag_needs_the_no_print_conversion_form() {
    let s = session_or_skip!();
    let scratch = Scratch::new("rawnumeric", "north_gps.jpg");
    let path = scratch.file.to_str().unwrap();

    // What a naive implementation would send. ExifTool refuses to convert it
    // and changes nothing — while reporting only a warning.
    let bare = s
        .execute(&[
            "-overwrite_original".into(),
            "-EXIF:Flash=16".into(),
            path.into(),
        ])
        .expect("the request itself should succeed");
    assert!(
        !bare.has_error(),
        "the bare form fails as a *warning*, which is what makes it dangerous: {}",
        bare.stderr
    );
    assert!(
        bare.stderr.contains("PrintConv") || bare.stderr.contains("Nothing to do"),
        "expected a conversion warning, got: {:?}",
        bare.stderr
    );
    assert!(
        full_dump(&s, &scratch.file).get("EXIF:Flash").is_none(),
        "the bare form should have written nothing at all"
    );

    // What this app sends.
    write::apply_edit(
        &s,
        &scratch.dir,
        path,
        &tag_edit_of(vec![(
            "EXIF:Flash",
            TagEdit::Set { value: serde_json::json!(16) },
        )]),
    )
    .expect("the # form should write");

    let after = full_dump(&s, &scratch.file);
    // Read back with -n, the same way the inspector shows it. What the user
    // typed is what the file now holds.
    assert_eq!(after.get("EXIF:Flash").map(String::as_str), Some("16"));
}

#[test]
fn editing_a_raw_tag_changes_only_that_tag() {
    let s = session_or_skip!();
    let scratch = Scratch::new("rawonly", "north_gps.jpg");

    let before = full_dump(&s, &scratch.file);
    write::apply_edit(
        &s,
        &scratch.dir,
        scratch.file.to_str().unwrap(),
        &tag_edit_of(vec![(
            "EXIF:Software",
            TagEdit::Set { value: serde_json::json!("Revery Exif") },
        )]),
    )
    .expect("write");

    let after = full_dump(&s, &scratch.file);
    let mut unexpected = Vec::new();
    for (tag, old) in &before {
        if is_incidental(tag) || tag == "EXIF:Software" {
            continue;
        }
        match after.get(tag) {
            None => unexpected.push(format!("{tag}: DROPPED (was {old})")),
            Some(new) if new != old => unexpected.push(format!("{tag}: {old} -> {new}")),
            _ => {}
        }
    }
    assert!(unexpected.is_empty(), "a raw tag edit disturbed: {unexpected:#?}");
    assert_eq!(
        after.get("EXIF:Software").map(String::as_str),
        Some("\"Revery Exif\"")
    );
}

#[test]
fn clearing_a_raw_tag_removes_only_it() {
    let s = session_or_skip!();
    let scratch = Scratch::new("rawclear", "north_gps.jpg");

    let before = full_dump(&s, &scratch.file);
    assert!(before.contains_key("EXIF:Artist"), "fixture should have an Artist");

    write::apply_edit(
        &s,
        &scratch.dir,
        scratch.file.to_str().unwrap(),
        &tag_edit_of(vec![("EXIF:Artist", TagEdit::Clear)]),
    )
    .expect("clear");

    let after = full_dump(&s, &scratch.file);
    assert!(!after.contains_key("EXIF:Artist"), "the tag survived being cleared");
    // The neighbouring tags in the same IFD must be untouched.
    assert_eq!(after.get("EXIF:Make"), before.get("EXIF:Make"));
    assert_eq!(after.get("EXIF:Model"), before.get("EXIF:Model"));
    assert_eq!(after.get("XMP:Title"), before.get("XMP:Title"));
}

/// A locked tag is refused before anything is copied, not after.
#[test]
fn a_render_critical_tag_is_refused_and_the_file_is_untouched() {
    let s = session_or_skip!();
    let scratch = Scratch::new("rawlocked", "north_gps.jpg");
    let before = scratch.bytes();

    for tag in ["EXIF:Orientation", "EXIF:ColorSpace", "JFIF:JFIFVersion"] {
        let err = write::apply_edit(
            &s,
            &scratch.dir,
            scratch.file.to_str().unwrap(),
            &tag_edit_of(vec![(tag, TagEdit::Clear)]),
        )
        .expect_err(&format!("{tag} should be refused"));
        assert!(err.contains("cannot be changed"), "{tag}: {err}");
    }
    assert_eq!(scratch.bytes(), before, "a refused edit still touched the file");
}

/// A raw tag edit is undoable like any other.
#[test]
fn a_raw_tag_edit_can_be_undone() {
    let s = session_or_skip!();
    let scratch = Scratch::new("rawundo", "north_gps.jpg");
    let before = scratch.bytes();

    write::apply_batch(
        &s,
        &scratch.dir,
        &[scratch.file.to_string_lossy().into_owned()],
        &tag_edit_of(vec![(
            "EXIF:UserComment",
            TagEdit::Set { value: serde_json::json!("staged from the All tab") },
        )]),
    )
    .expect("write");
    assert_ne!(scratch.bytes(), before, "the write should have changed the file");

    let undone = revery_exif_core::undo::undo_last(&scratch.dir).expect("undo");
    assert_eq!(undone.restored, 1);
    assert_eq!(scratch.bytes(), before, "the file was not restored exactly");
}

/* ══════════════════════════════════════════════════════════════════════════
   CONCURRENCY

   The Tauri commands used to be synchronous, which meant they ran one at a
   time on the UI thread and nothing here could overlap. That froze the window
   for the length of a batch, so the commands are `async` now — and these are
   the assertions that had to exist before that was safe to do.
══════════════════════════════════════════════════════════════════════════ */

/// Two batches at once must not destroy each other's undo.
///
/// `UndoBatch::begin` opens by deleting the store, so without serialisation:
///
/// ```text
///   A  begin ── snapshot ─────────────── finish (manifest names A's snapshots)
///   B          begin ← deletes the store, taking A's snapshots with it
/// ```
///
/// and undoing reports "the saved copy is missing" for every file it just
/// promised to restore. `write::MUTATION_LOCK` is what makes this pass.
#[test]
fn overlapping_batches_do_not_destroy_each_other() {
    let s = std::sync::Arc::new(session_or_skip!());

    let dir = std::env::temp_dir().join(format!("revery-concurrent-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    // A is deliberately long and B deliberately short, and B starts a moment
    // late, so B's `begin` lands in the middle of A rather than depending on
    // the scheduler to produce the overlap by chance.
    const A_FILES: usize = 16;
    const B_FILES: usize = 2;
    let total = A_FILES + B_FILES;
    let mut originals = Vec::new();
    for i in 0..total {
        let file = dir.join(format!("p{i}.jpg"));
        std::fs::copy(fixtures().join("no_gps.jpg"), &file).unwrap();
        originals.push((file.clone(), std::fs::read(&file).unwrap()));
    }

    let batch = |s: std::sync::Arc<ExifToolSession>, dir: PathBuf, range: std::ops::Range<usize>, label: &'static str, delay_ms: u64| {
        std::thread::spawn(move || {
            if delay_ms > 0 {
                std::thread::sleep(std::time::Duration::from_millis(delay_ms));
            }
            let edits: Vec<(String, PhotoEdit)> = range
                .map(|i| {
                    (
                        dir.join(format!("p{i}.jpg")).to_string_lossy().into_owned(),
                        edit_of(vec![("title", set(serde_json::json!(label)))]),
                    )
                })
                .collect();
            write::apply_per_file(&s, &dir, &edits)
        })
    };

    let long = batch(std::sync::Arc::clone(&s), dir.clone(), 0..A_FILES, "long", 0);
    let short = batch(std::sync::Arc::clone(&s), dir.clone(), A_FILES..total, "short", 15);

    for outcome in [long.join().unwrap(), short.join().unwrap()] {
        let outcome = outcome.expect("batch should not fail outright");
        assert_eq!(outcome.failed, 0, "a file failed: {:?}", outcome.results);
    }

    // Whichever batch finished last owns the store, and its manifest must name
    // snapshots that still exist. The failure guarded against is a manifest
    // promising restores it cannot perform — every entry reporting "the saved
    // copy is missing" because the other batch's `begin` deleted them.
    let outcome = revery_exif_core::undo::undo_last(&dir).expect("undo should be available");
    assert!(
        outcome.failed.is_empty(),
        "undo could not restore what it promised: {:?}",
        outcome.failed
    );
    assert!(outcome.restored > 0, "the manifest restored nothing");

    // Everything it claimed to restore is byte-identical to how it started.
    let restored = originals
        .iter()
        .filter(|(path, before)| std::fs::read(path).unwrap() == *before)
        .count();
    assert_eq!(
        restored, outcome.restored,
        "undo reported {} restored but {restored} files match their original bytes",
        outcome.restored
    );

    std::fs::remove_dir_all(&dir).ok();
}

/// A folder opening mid-write must not delete the write's staged temp.
///
/// `sweep_stale_temps` removes `.revery_exif.tmp` siblings, which is exactly
/// what a running write has staged and not yet renamed. Left unserialised, the
/// sweep is indistinguishable from crash cleanup and takes live work with it.
#[test]
fn a_sweep_cannot_delete_a_running_writes_temp() {
    let s = std::sync::Arc::new(session_or_skip!());

    let dir = std::env::temp_dir().join(format!("revery-sweeprace-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    for i in 0..8 {
        std::fs::copy(fixtures().join("no_gps.jpg"), dir.join(format!("p{i}.jpg"))).unwrap();
    }

    let writer = {
        let s = std::sync::Arc::clone(&s);
        let dir = dir.clone();
        std::thread::spawn(move || {
            let edits: Vec<(String, PhotoEdit)> = (0..8)
                .map(|i| {
                    (
                        dir.join(format!("p{i}.jpg")).to_string_lossy().into_owned(),
                        edit_of(vec![("title", set(serde_json::json!("kept")))]),
                    )
                })
                .collect();
            write::apply_per_file(&s, &dir, &edits)
        })
    };

    // Hammer the sweep while the batch runs.
    let sweeper = {
        let dir = dir.clone();
        std::thread::spawn(move || {
            for _ in 0..40 {
                write::sweep_stale_temps(&dir);
                std::thread::yield_now();
            }
        })
    };

    let outcome = writer.join().unwrap().expect("the batch should not fail outright");
    sweeper.join().unwrap();

    assert_eq!(
        outcome.failed, 0,
        "a concurrent sweep destroyed a staged write: {:?}",
        outcome.results
    );
    // Every file got the edit, rather than some being lost to the sweep.
    for i in 0..8 {
        let read = library::read_metadata(&s, &[dir.join(format!("p{i}.jpg"))]).unwrap();
        assert_eq!(
            read.get(0).and_then(|e| e.get("XMP:Title")).and_then(|v| v.as_str()),
            Some("kept"),
            "p{i}.jpg did not keep its edit"
        );
    }

    std::fs::remove_dir_all(&dir).ok();
}
