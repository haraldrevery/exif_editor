//! Geotagging end to end: a real GPX track, real photos, the real write path.
//!
//! The unit tests in `gpx.rs` check matching against hand-built JSON. These
//! check that the positions actually reach the files, and — the point of the
//! whole feature — that the preview the user approved is what got written.

use std::path::PathBuf;

use revery_exif_core::exiftool::ExifToolSession;
use revery_exif_core::gpx::{self, NoMatch, Track, DEFAULT_MAX_GAP_SECS};
use revery_exif_core::library;
use revery_exif_core::write::{self, GpsEdit, PhotoEdit};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("tauri/ has a parent")
        .to_path_buf()
}

fn fixtures() -> PathBuf {
    repo_root().join("test/fixtures")
}

fn session() -> Option<ExifToolSession> {
    if !fixtures().join("north_gps.jpg").is_file() {
        eprintln!("skipping: fixtures missing — run build_tools/make_fixtures.py");
        return None;
    }
    ExifToolSession::locate(&repo_root())
        .ok()
        .map(ExifToolSession::new)
}

macro_rules! session_or_skip {
    () => {
        match session() {
            Some(s) => s,
            None => return,
        }
    };
}

/// A folder of photos with known capture times, and a track covering them.
struct Trip {
    dir: PathBuf,
    photos: Vec<PathBuf>,
}

impl Trip {
    /// `times` are EXIF DateTimeOriginal values, written into copies of a
    /// location-free fixture.
    fn new(name: &str, session: &ExifToolSession, times: &[&str]) -> Self {
        let dir = std::env::temp_dir().join(format!("revery-geotag-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let photos: Vec<PathBuf> = times
            .iter()
            .enumerate()
            .map(|(i, taken)| {
                let path = dir.join(format!("photo_{i:02}.jpg"));
                std::fs::copy(fixtures().join("no_gps.jpg"), &path).unwrap();
                session
                    .execute(&[
                        "-overwrite_original".into(),
                        format!("-EXIF:DateTimeOriginal={taken}"),
                        path.to_string_lossy().into_owned(),
                    ])
                    .unwrap();
                path
            })
            .collect();
        Self { dir, photos }
    }

    fn write_track(&self, xml: &str) -> PathBuf {
        let path = self.dir.join("track.gpx");
        std::fs::write(&path, xml).unwrap();
        path
    }

    fn paths(&self) -> Vec<PathBuf> {
        self.photos.clone()
    }
}

impl Drop for Trip {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// A track running 09:00–09:20 UTC, moving north-east.
const TRACK: &str = r#"<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><trkseg>
    <trkpt lat="59.9000" lon="10.7000"><ele>10</ele><time>2024-06-15T09:00:00Z</time></trkpt>
    <trkpt lat="59.9100" lon="10.7200"><ele>20</ele><time>2024-06-15T09:10:00Z</time></trkpt>
    <trkpt lat="59.9200" lon="10.7400"><ele>30</ele><time>2024-06-15T09:20:00Z</time></trkpt>
  </trkseg></trk>
</gpx>"#;

fn read_entries(session: &ExifToolSession, paths: &[PathBuf]) -> Vec<serde_json::Value> {
    library::read_metadata(session, paths)
        .expect("read")
        .as_array()
        .cloned()
        .unwrap_or_default()
}

/// Turns matches into the per-file edits the command layer builds.
fn edits_from(matches: &[gpx::GeotagMatch]) -> Vec<(String, PhotoEdit)> {
    matches
        .iter()
        .filter_map(|m| {
            let position = m.position?;
            let mut edit = PhotoEdit::default();
            edit.gps = Some(GpsEdit::Set { position });
            Some((m.path.clone(), edit))
        })
        .collect()
}

#[test]
fn geotagging_writes_the_previewed_positions() {
    let s = session_or_skip!();
    let trip = Trip::new(
        "writes",
        &s,
        &[
            "2024:06:15 09:00:00", // exactly the first fix
            "2024:06:15 09:05:00", // interpolated
            "2024:06:15 09:20:00", // exactly the last fix
        ],
    );
    trip.write_track(TRACK);
    let track = Track::parse(TRACK).unwrap();

    let entries = read_entries(&s, &trip.paths());
    let matches = gpx::match_photos(&track, &entries, 0, DEFAULT_MAX_GAP_SECS);
    assert!(matches.iter().all(|m| m.matched()), "{matches:?}");

    let outcome = write::apply_per_file(&s, &trip.dir, &edits_from(&matches)).expect("apply");
    assert_eq!(outcome.succeeded, 3);
    assert_eq!(outcome.failed, 0);

    // What was previewed is what is on disk. If these ever diverged, the
    // review dialog would be describing a different operation than the one it
    // performs.
    let after = read_entries(&s, &trip.paths());
    for (entry, expected) in after.iter().zip(&matches) {
        let actual = library::position_from_metadata(entry).expect("position was written");
        let expected = expected.position.unwrap();
        assert!(
            (actual.latitude - expected.latitude).abs() < 1e-4
                && (actual.longitude - expected.longitude).abs() < 1e-4,
            "previewed {expected:?} but wrote {actual:?}"
        );
    }

    // And the middle photo really was interpolated, not snapped to a fix.
    let middle = library::position_from_metadata(&after[1]).unwrap();
    assert!((middle.latitude - 59.9050).abs() < 1e-4, "{middle:?}");
}

#[test]
fn photos_outside_the_track_are_left_completely_alone() {
    let s = session_or_skip!();
    let trip = Trip::new(
        "outside",
        &s,
        &[
            "2024:06:15 06:00:00", // hours before the track
            "2024:06:15 09:05:00", // inside
            "2024:06:15 18:00:00", // hours after
        ],
    );
    trip.write_track(TRACK);
    let track = Track::parse(TRACK).unwrap();

    let before: Vec<_> = trip.paths().iter().map(|p| std::fs::read(p).unwrap()).collect();
    let entries = read_entries(&s, &trip.paths());
    let matches = gpx::match_photos(&track, &entries, 0, DEFAULT_MAX_GAP_SECS);

    assert_eq!(matches[0].reason, Some(NoMatch::BeforeTrack));
    assert!(matches[1].matched());
    assert_eq!(matches[2].reason, Some(NoMatch::AfterTrack));

    let outcome = write::apply_per_file(&s, &trip.dir, &edits_from(&matches)).expect("apply");
    // Only the one that matched is written; the others are not in the batch at
    // all, so they are not merely "unchanged" — they are never opened.
    assert_eq!(outcome.succeeded, 1);
    assert_eq!(outcome.results.len(), 1);

    let after: Vec<_> = trip.paths().iter().map(|p| std::fs::read(p).unwrap()).collect();
    assert_eq!(after[0], before[0], "a photo before the track was modified");
    assert_ne!(after[1], before[1], "the matching photo should have changed");
    assert_eq!(after[2], before[2], "a photo after the track was modified");
}

#[test]
fn the_timezone_offset_decides_whether_photos_match_at_all() {
    let s = session_or_skip!();
    // A camera set to local time in Oslo: 11:05 local is 09:05 UTC.
    let trip = Trip::new("timezone", &s, &["2024:06:15 11:05:00"]);
    trip.write_track(TRACK);
    let track = Track::parse(TRACK).unwrap();
    let entries = read_entries(&s, &trip.paths());

    // Read as UTC, the photo lands well after the track ends.
    let naive = gpx::match_photos(&track, &entries, 0, DEFAULT_MAX_GAP_SECS);
    assert!(!naive[0].matched());
    assert_eq!(naive[0].reason, Some(NoMatch::AfterTrack));

    // With the right offset it lands in the middle. This is the single control
    // that most often decides whether geotagging appears to "work", which is
    // why the UI shows the match count live as it is changed.
    let corrected = gpx::match_photos(&track, &entries, 7200, DEFAULT_MAX_GAP_SECS);
    assert!(corrected[0].matched());
}

#[test]
fn a_camera_recorded_offset_is_used_instead_of_the_fallback() {
    let s = session_or_skip!();
    let trip = Trip::new("offsettag", &s, &["2024:06:15 11:05:00"]);
    // Newer cameras record the zone. When they have, there is nothing to guess.
    s.execute(&[
        "-overwrite_original".into(),
        "-EXIF:OffsetTimeOriginal=+02:00".into(),
        trip.photos[0].to_string_lossy().into_owned(),
    ])
    .unwrap();
    trip.write_track(TRACK);
    let track = Track::parse(TRACK).unwrap();
    let entries = read_entries(&s, &trip.paths());

    // The fallback is deliberately wrong; the file's own value must win.
    let matches = gpx::match_photos(&track, &entries, -18_000, DEFAULT_MAX_GAP_SECS);
    assert!(
        matches[0].matched(),
        "the camera's own offset was ignored: {:?}",
        matches[0].reason
    );
}

#[test]
fn geotagging_preserves_the_rest_of_the_metadata() {
    let s = session_or_skip!();
    let trip = Trip::new("preserve", &s, &["2024:06:15 09:05:00"]);
    // Give the photo some metadata worth losing.
    s.execute(&[
        "-overwrite_original".into(),
        "-XMP:Title=Fjord morning".into(),
        "-EXIF:Artist=Harald Revery".into(),
        trip.photos[0].to_string_lossy().into_owned(),
    ])
    .unwrap();
    trip.write_track(TRACK);
    let track = Track::parse(TRACK).unwrap();

    let entries = read_entries(&s, &trip.paths());
    let matches = gpx::match_photos(&track, &entries, 0, DEFAULT_MAX_GAP_SECS);
    write::apply_per_file(&s, &trip.dir, &edits_from(&matches)).expect("apply");

    let after = read_entries(&s, &trip.paths());
    assert_eq!(after[0]["XMP:Title"].as_str(), Some("Fjord morning"));
    assert_eq!(after[0]["EXIF:Artist"].as_str(), Some("Harald Revery"));
    assert!(library::position_from_metadata(&after[0]).is_some());
}

#[test]
fn a_geotag_can_be_undone_like_any_other_batch() {
    let s = session_or_skip!();
    let trip = Trip::new("undo", &s, &["2024:06:15 09:02:00", "2024:06:15 09:12:00"]);
    trip.write_track(TRACK);
    let track = Track::parse(TRACK).unwrap();
    let before: Vec<_> = trip.paths().iter().map(|p| std::fs::read(p).unwrap()).collect();

    let entries = read_entries(&s, &trip.paths());
    let matches = gpx::match_photos(&track, &entries, 0, DEFAULT_MAX_GAP_SECS);
    let outcome = write::apply_per_file(&s, &trip.dir, &edits_from(&matches)).expect("apply");
    assert_eq!(outcome.succeeded, 2);
    assert!(outcome.undo_unavailable.is_none());

    // Geotagging goes through the same write path, so it inherits undo rather
    // than needing its own — which matters, because a geotag applied with the
    // wrong timezone is exactly the mistake people want to take back.
    let undone = revery_exif_core::undo::undo_last(&trip.dir).expect("undo");
    assert_eq!(undone.restored, 2);
    for (path, original) in trip.paths().iter().zip(&before) {
        assert_eq!(&std::fs::read(path).unwrap(), original, "{path:?} not restored");
    }
}

#[test]
fn geotagging_reports_which_photos_would_lose_an_existing_location() {
    let s = session_or_skip!();
    let trip = Trip::new("replace", &s, &["2024:06:15 09:05:00", "2024:06:15 09:15:00"]);
    // The first photo already has a fix, from a different source.
    s.execute(&[
        "-overwrite_original".into(),
        "-GPSLatitude=-33.4489".into(),
        "-GPSLatitudeRef=-33.4489".into(),
        "-GPSLongitude=-70.6693".into(),
        "-GPSLongitudeRef=-70.6693".into(),
        trip.photos[0].to_string_lossy().into_owned(),
    ])
    .unwrap();
    trip.write_track(TRACK);
    let track = Track::parse(TRACK).unwrap();

    let entries = read_entries(&s, &trip.paths());
    let matches = gpx::match_photos(&track, &entries, 0, DEFAULT_MAX_GAP_SECS);
    // Overwriting a location is a different act from filling in a blank, and
    // the review has to be able to warn about it.
    assert!(matches[0].had_position);
    assert!(!matches[1].had_position);
}

#[test]
fn a_track_covering_nothing_writes_nothing() {
    let s = session_or_skip!();
    let trip = Trip::new("nomatch", &s, &["2020:01:01 00:00:00"]);
    trip.write_track(TRACK);
    let track = Track::parse(TRACK).unwrap();

    let entries = read_entries(&s, &trip.paths());
    let matches = gpx::match_photos(&track, &entries, 0, DEFAULT_MAX_GAP_SECS);
    let edits = edits_from(&matches);
    assert!(edits.is_empty());

    // An empty batch must be refused rather than reported as a success that
    // changed nothing.
    assert!(write::apply_per_file(&s, &trip.dir, &edits).is_err());
}

#[test]
fn a_malformed_track_is_rejected_before_any_matching() {
    assert!(Track::parse("<gpx><trk></trk></gpx>").is_err());
    assert!(Track::parse("").is_err());
    // A GPX of waypoints with no times is a common thing to have lying around;
    // it must not silently behave like a track that matches nothing.
    let err = Track::parse(r#"<gpx><wpt lat="1" lon="2"><name>Home</name></wpt></gpx>"#)
        .unwrap_err();
    assert!(err.contains("timestamp"), "unhelpful: {err}");
}
