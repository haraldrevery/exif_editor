//! GPX track parsing and position interpolation.
//!
//! Geotagging matches each photo's capture time against a recorded track. The
//! matching is done here rather than handed to ExifTool's `-geotag` for one
//! reason: the app has to show **which photos will not match, and why**, before
//! anything is written. A preview that came from a different implementation
//! than the write would eventually disagree with it.
//!
//! Doing it here also means geotagging writes through the same verified,
//! undoable path as every other edit, instead of being a second write
//! mechanism with its own failure modes.
//!
//! # Time, which is the whole problem
//!
//! GPX timestamps are UTC and explicit. `EXIF:DateTimeOriginal` is local wall
//! clock with **no zone at all** — `2024:06:15 09:41:00` could be any of
//! twenty-odd instants. Newer cameras record `OffsetTimeOriginal`; most do not.
//!
//! So the offset is either read from the file or supplied by the user, and it
//! is never guessed. Guessing wrong by an hour puts every photo at whatever the
//! track was doing an hour earlier — plausibly wrong, which is worse than
//! obviously wrong.

use serde::{Deserialize, Serialize};

use crate::library::GpsPosition;

/// One recorded fix. `time` is a Unix timestamp in seconds (UTC).
#[derive(Debug, Clone, PartialEq)]
pub struct TrackPoint {
    pub time: i64,
    pub latitude: f64,
    pub longitude: f64,
    pub elevation: Option<f64>,
}

/// A track, ordered by time.
#[derive(Debug, Clone, Default)]
pub struct Track {
    pub points: Vec<TrackPoint>,
}

/// How far a photo's time may sit from the nearest fix before the match is
/// refused, in seconds. Thirty minutes matches ExifTool's own default.
///
/// The point is not to be generous. A photo taken during an hour-long gap —
/// the receiver indoors, or switched off — would otherwise be placed on the
/// straight line between where the track stopped and where it resumed, which
/// is a road the photographer may never have travelled.
pub const DEFAULT_MAX_GAP_SECS: i64 = 1800;

impl Track {
    /// Parses GPX. Accepts track points (`trkpt`), route points (`rtept`) and
    /// standalone waypoints (`wpt`) — different loggers emit different ones,
    /// and the geometry is identical for our purposes.
    ///
    /// Points without a timestamp are skipped: they cannot be matched to a
    /// photo, and silently treating them as position-only data would let a
    /// waypoint file look like a usable track.
    pub fn parse(xml: &str) -> Result<Track, String> {
        let document = roxmltree::Document::parse(xml)
            .map_err(|e| format!("This is not readable GPX: {e}"))?;

        let mut points = Vec::new();
        let mut untimed = 0usize;

        for node in document.descendants() {
            if !matches!(node.tag_name().name(), "trkpt" | "rtept" | "wpt") {
                continue;
            }
            let (Some(lat), Some(lon)) = (node.attribute("lat"), node.attribute("lon")) else {
                continue;
            };
            let (Ok(latitude), Ok(longitude)) = (lat.parse::<f64>(), lon.parse::<f64>()) else {
                continue;
            };
            if !(-90.0..=90.0).contains(&latitude) || !(-180.0..=180.0).contains(&longitude) {
                continue;
            }

            let time = node
                .children()
                .find(|c| c.tag_name().name() == "time")
                .and_then(|c| c.text())
                .and_then(parse_iso8601);
            let Some(time) = time else {
                untimed += 1;
                continue;
            };

            let elevation = node
                .children()
                .find(|c| c.tag_name().name() == "ele")
                .and_then(|c| c.text())
                .and_then(|t| t.trim().parse::<f64>().ok());

            points.push(TrackPoint {
                time,
                latitude,
                longitude,
                elevation,
            });
        }

        if points.is_empty() {
            return Err(if untimed > 0 {
                format!(
                    "This file has {untimed} point(s) but none carry a timestamp, \
                     so photos cannot be matched to it."
                )
            } else {
                "This file contains no track points.".to_string()
            });
        }

        // Loggers usually emit points in order, but a merged or edited file may
        // not be. Interpolation assumes ordering, so it is established here
        // rather than trusted.
        points.sort_by_key(|p| p.time);
        Ok(Track { points })
    }

    /// First and last recorded times.
    pub fn time_range(&self) -> Option<(i64, i64)> {
        Some((self.points.first()?.time, self.points.last()?.time))
    }

    /// The position at `time`, or `None` when the track cannot answer.
    ///
    /// Returns `None` when `time` falls outside the track, or inside a gap
    /// longer than `max_gap` — in both cases the honest answer is "this photo
    /// was not covered", not a plausible-looking interpolation.
    pub fn position_at(&self, time: i64, max_gap: i64) -> Option<GpsPosition> {
        if self.points.is_empty() {
            return None;
        }
        let first = self.points.first()?;
        let last = self.points.last()?;

        // Just before the start or just after the end: hold the endpoint, but
        // only within tolerance. This covers the ordinary case of switching the
        // logger on a minute after the first photo.
        if time < first.time {
            return (first.time - time <= max_gap).then(|| position_of(first));
        }
        if time > last.time {
            return (time - last.time <= max_gap).then(|| position_of(last));
        }

        // Inside the track: find the bracketing pair.
        let index = self.points.partition_point(|p| p.time <= time);
        if index == 0 {
            return Some(position_of(first));
        }
        let before = &self.points[index - 1];
        if before.time == time || index >= self.points.len() {
            return Some(position_of(before));
        }
        let after = &self.points[index];

        // A hole in the recording. Interpolating across it would invent a
        // straight-line path the photographer never took.
        if after.time - before.time > max_gap {
            return None;
        }

        let span = (after.time - before.time) as f64;
        let ratio = if span == 0.0 {
            0.0
        } else {
            (time - before.time) as f64 / span
        };
        Some(GpsPosition {
            latitude: before.latitude + (after.latitude - before.latitude) * ratio,
            longitude: interpolate_longitude(before.longitude, after.longitude, ratio),
            altitude: match (before.elevation, after.elevation) {
                (Some(a), Some(b)) => Some(a + (b - a) * ratio),
                (Some(a), None) => Some(a),
                (None, Some(b)) => Some(b),
                (None, None) => None,
            },
        })
    }
}

fn position_of(point: &TrackPoint) -> GpsPosition {
    GpsPosition {
        latitude: point.latitude,
        longitude: point.longitude,
        altitude: point.elevation,
    }
}

/// Interpolates longitude the short way round.
///
/// Crossing the antimeridian, a naive average between +179 and -179 travels
/// 358° westward through the whole world and lands at 0° — the Gulf of Guinea —
/// instead of moving 2° across the date line.
fn interpolate_longitude(from: f64, to: f64, ratio: f64) -> f64 {
    let mut delta = to - from;
    if delta > 180.0 {
        delta -= 360.0;
    } else if delta < -180.0 {
        delta += 360.0;
    }
    let mut result = from + delta * ratio;
    if result > 180.0 {
        result -= 360.0;
    } else if result < -180.0 {
        result += 360.0;
    }
    result
}

/* ══════════════════════════════════════════════════════════════════════════
   TIME
══════════════════════════════════════════════════════════════════════════ */

/// Parses an ISO 8601 timestamp as found in GPX: `2024-06-15T09:41:00Z`.
///
/// Accepts fractional seconds and a numeric zone offset. A timestamp with no
/// zone marker is read as UTC, which is what the GPX specification requires.
pub fn parse_iso8601(text: &str) -> Option<i64> {
    let text = text.trim();
    let bytes = text.as_bytes();
    if text.len() < 19 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let year: i64 = text.get(0..4)?.parse().ok()?;
    let month: u32 = text.get(5..7)?.parse().ok()?;
    let day: u32 = text.get(8..10)?.parse().ok()?;
    // Either 'T' or a space; some loggers emit the latter.
    if !matches!(bytes[10], b'T' | b't' | b' ') {
        return None;
    }
    let hour: i64 = text.get(11..13)?.parse().ok()?;
    let minute: i64 = text.get(14..16)?.parse().ok()?;
    let second: i64 = text.get(17..19)?.parse().ok()?;

    let mut timestamp = days_from_civil(year, month, day)? * 86_400
        + hour * 3600
        + minute * 60
        + second;

    // Trailing zone, if any.
    let rest = &text[19..];
    let rest = rest.trim_start_matches(|c: char| c == '.' || c.is_ascii_digit());
    if let Some(sign_index) = rest.find(['+', '-']) {
        let zone = &rest[sign_index..];
        let sign = if zone.starts_with('-') { -1 } else { 1 };
        let digits: String = zone[1..].chars().filter(|c| c.is_ascii_digit()).collect();
        if digits.len() >= 4 {
            let zh: i64 = digits[0..2].parse().ok()?;
            let zm: i64 = digits[2..4].parse().ok()?;
            timestamp -= sign * (zh * 3600 + zm * 60);
        }
    }
    Some(timestamp)
}

/// Days since 1970-01-01 for a proleptic Gregorian date.
///
/// Howard Hinnant's `days_from_civil`. Written out rather than pulled from a
/// date library: this is the only calendar arithmetic in the project, and it is
/// exactly testable.
fn days_from_civil(year: i64, month: u32, day: u32) -> Option<i64> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let m = month as i64;
    let d = day as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

/// The inverse of [`days_from_civil`].
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m as u32, d as u32)
}

/// Formats a timestamp back into EXIF's `2024:06:15 09:41:00`.
///
/// Used to predict what a date shift will produce, so the preview and the
/// verification after the write are the same arithmetic.
pub fn format_exif_datetime(timestamp: i64) -> String {
    // Floor division, so times before 1970 do not round towards zero and land
    // a day out.
    let days = timestamp.div_euclid(86_400);
    let secs = timestamp.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}:{month:02}:{day:02} {:02}:{:02}:{:02}",
        secs / 3600,
        (secs % 3600) / 60,
        secs % 60
    )
}

/// Parses `EXIF:DateTimeOriginal` — `2024:06:15 09:41:00`, local wall clock.
///
/// Returns seconds as if the value were UTC. The caller applies the real
/// offset; there is nothing in the value itself to tell us what it is.
pub fn parse_exif_datetime(text: &str) -> Option<i64> {
    let text = text.trim();
    if text.len() < 19 {
        return None;
    }
    let bytes = text.as_bytes();
    if bytes[4] != b':' || bytes[7] != b':' {
        return None;
    }
    let year: i64 = text.get(0..4)?.parse().ok()?;
    let month: u32 = text.get(5..7)?.parse().ok()?;
    let day: u32 = text.get(8..10)?.parse().ok()?;
    let hour: i64 = text.get(11..13)?.parse().ok()?;
    let minute: i64 = text.get(14..16)?.parse().ok()?;
    let second: i64 = text.get(17..19)?.parse().ok()?;
    Some(days_from_civil(year, month, day)? * 86_400 + hour * 3600 + minute * 60 + second)
}

/// Parses `EXIF:OffsetTimeOriginal` — `+02:00`, `-05:00`, `Z`.
///
/// Cameras that record this remove the guesswork entirely, so it is always
/// preferred over anything the user typed.
pub fn parse_utc_offset(text: &str) -> Option<i64> {
    let text = text.trim();
    if text.eq_ignore_ascii_case("Z") {
        return Some(0);
    }
    let sign = match text.chars().next()? {
        '+' => 1,
        '-' => -1,
        _ => return None,
    };
    let digits: String = text[1..].chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() < 2 {
        return None;
    }
    let hours: i64 = digits.get(0..2)?.parse().ok()?;
    let minutes: i64 = if digits.len() >= 4 {
        digits.get(2..4)?.parse().ok()?
    } else {
        0
    };
    if hours > 14 || minutes >= 60 {
        return None;
    }
    Some(sign * (hours * 3600 + minutes * 60))
}

/* ══════════════════════════════════════════════════════════════════════════
   MATCHING
══════════════════════════════════════════════════════════════════════════ */

/// Why a photo could not be geotagged.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NoMatch {
    /// No `DateTimeOriginal`, so there is nothing to match on.
    NoCaptureTime,
    /// Taken before the track began.
    BeforeTrack,
    /// Taken after the track ended.
    AfterTrack,
    /// Inside the track's span, but in a gap in the recording.
    InsideGap,
}

/// What geotagging would do to one photo.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeotagMatch {
    pub path: String,
    /// The photo's capture time as UTC, once the offset is applied.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capture_utc: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<GpsPosition>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<NoMatch>,
    /// Whether this photo already has a location that would be replaced.
    pub had_position: bool,
}

impl GeotagMatch {
    pub fn matched(&self) -> bool {
        self.position.is_some()
    }
}

/// Everything the review needs before anything is written.
///
/// Field names are part of the contract with `www/js/geotag.js`; the test
/// `the_preview_json_matches_what_the_frontend_reads` pins them, because a
/// rename here would otherwise turn the summary into `undefined of undefined`
/// with nothing failing.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeotagPreview {
    pub matches: Vec<GeotagMatch>,
    pub matched: usize,
    /// How many matched photos already have a location that would be replaced.
    pub would_replace: usize,
    pub track_points: usize,
    pub track_start: i64,
    pub track_end: i64,
}

impl GeotagPreview {
    pub fn build(track: &Track, matches: Vec<GeotagMatch>) -> Self {
        let (track_start, track_end) = track.time_range().unwrap_or((0, 0));
        Self {
            matched: matches.iter().filter(|m| m.matched()).count(),
            would_replace: matches
                .iter()
                .filter(|m| m.matched() && m.had_position)
                .count(),
            track_points: track.points.len(),
            track_start,
            track_end,
            matches,
        }
    }
}

/// Works out what geotagging would do, without writing anything.
///
/// `entries` are ExifTool tag objects. `fallback_offset` is used only for
/// photos that do not carry `OffsetTimeOriginal`.
pub fn match_photos(
    track: &Track,
    entries: &[serde_json::Value],
    fallback_offset: i64,
    max_gap: i64,
) -> Vec<GeotagMatch> {
    let range = track.time_range();
    entries
        .iter()
        .map(|entry| {
            let path = entry
                .get("SourceFile")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let had_position = crate::library::position_from_metadata(entry).is_some();

            let local = entry
                .get("EXIF:DateTimeOriginal")
                .and_then(|v| v.as_str())
                .and_then(parse_exif_datetime);
            let Some(local) = local else {
                return GeotagMatch {
                    path,
                    capture_utc: None,
                    position: None,
                    reason: Some(NoMatch::NoCaptureTime),
                    had_position,
                };
            };

            // The camera's own offset wins whenever it recorded one.
            let offset = entry
                .get("EXIF:OffsetTimeOriginal")
                .and_then(|v| v.as_str())
                .and_then(parse_utc_offset)
                .unwrap_or(fallback_offset);
            let utc = local - offset;

            let position = track.position_at(utc, max_gap);
            let reason = if position.is_some() {
                None
            } else {
                Some(match range {
                    Some((start, _)) if utc < start => NoMatch::BeforeTrack,
                    Some((_, end)) if utc > end => NoMatch::AfterTrack,
                    _ => NoMatch::InsideGap,
                })
            };

            GeotagMatch {
                path,
                capture_utc: Some(utc),
                position,
                reason,
                had_position,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><trkseg>
    <trkpt lat="59.9000" lon="10.7000"><ele>10</ele><time>2024-06-15T09:00:00Z</time></trkpt>
    <trkpt lat="59.9100" lon="10.7200"><ele>20</ele><time>2024-06-15T09:10:00Z</time></trkpt>
    <trkpt lat="59.9200" lon="10.7400"><ele>30</ele><time>2024-06-15T09:20:00Z</time></trkpt>
  </trkseg></trk>
</gpx>"#;

    #[test]
    fn parses_points_in_time_order() {
        let track = Track::parse(SAMPLE).unwrap();
        assert_eq!(track.points.len(), 3);
        let (start, end) = track.time_range().unwrap();
        assert_eq!(end - start, 1200);
        assert!(track.points.windows(2).all(|w| w[0].time <= w[1].time));
    }

    #[test]
    fn sorts_points_that_arrive_out_of_order() {
        // A merged or hand-edited file. Interpolation assumes ordering, so it
        // must be established rather than assumed.
        let xml = r#"<gpx><trk><trkseg>
            <trkpt lat="1" lon="1"><time>2024-06-15T09:20:00Z</time></trkpt>
            <trkpt lat="0" lon="0"><time>2024-06-15T09:00:00Z</time></trkpt>
        </trkseg></trk></gpx>"#;
        let track = Track::parse(xml).unwrap();
        assert_eq!(track.points[0].latitude, 0.0);
        assert!(track.points[0].time < track.points[1].time);
    }

    #[test]
    fn interpolates_between_fixes() {
        let track = Track::parse(SAMPLE).unwrap();
        // Halfway between the first two points.
        let p = track.position_at(parse_iso8601("2024-06-15T09:05:00Z").unwrap(), 1800).unwrap();
        assert!((p.latitude - 59.9050).abs() < 1e-6, "{p:?}");
        assert!((p.longitude - 10.7100).abs() < 1e-6, "{p:?}");
        assert!((p.altitude.unwrap() - 15.0).abs() < 1e-6, "{p:?}");
    }

    #[test]
    fn returns_an_exact_fix_without_interpolating() {
        let track = Track::parse(SAMPLE).unwrap();
        let p = track.position_at(parse_iso8601("2024-06-15T09:10:00Z").unwrap(), 1800).unwrap();
        assert_eq!(p.latitude, 59.91);
        assert_eq!(p.longitude, 10.72);
    }

    #[test]
    fn refuses_to_interpolate_across_a_gap() {
        // The receiver lost signal for two hours. A photo taken in the middle
        // would otherwise be placed on the straight line between the two
        // points — a route the photographer never travelled.
        let xml = r#"<gpx><trk><trkseg>
            <trkpt lat="59.0" lon="10.0"><time>2024-06-15T09:00:00Z</time></trkpt>
            <trkpt lat="60.0" lon="11.0"><time>2024-06-15T11:00:00Z</time></trkpt>
        </trkseg></trk></gpx>"#;
        let track = Track::parse(xml).unwrap();
        let midpoint = parse_iso8601("2024-06-15T10:00:00Z").unwrap();
        assert!(track.position_at(midpoint, DEFAULT_MAX_GAP_SECS).is_none());
        // With a tolerance wide enough to cover the gap, it interpolates.
        assert!(track.position_at(midpoint, 7200).is_some());
    }

    #[test]
    fn holds_the_endpoints_only_within_tolerance() {
        let track = Track::parse(SAMPLE).unwrap();
        let start = parse_iso8601("2024-06-15T09:00:00Z").unwrap();
        // Five minutes before the logger was switched on: still reasonable.
        assert!(track.position_at(start - 300, 1800).is_some());
        // Five hours before: not.
        assert!(track.position_at(start - 18_000, 1800).is_none());
    }

    #[test]
    fn interpolates_the_short_way_across_the_antimeridian() {
        let xml = r#"<gpx><trk><trkseg>
            <trkpt lat="0" lon="179.0"><time>2024-06-15T09:00:00Z</time></trkpt>
            <trkpt lat="0" lon="-179.0"><time>2024-06-15T09:10:00Z</time></trkpt>
        </trkseg></trk></gpx>"#;
        let track = Track::parse(xml).unwrap();
        let mid = parse_iso8601("2024-06-15T09:05:00Z").unwrap();
        let p = track.position_at(mid, 1800).unwrap();
        // The short way is 2° across the date line, arriving at ±180. Averaging
        // naively would travel 358° the other way and land at 0° — the Gulf of
        // Guinea, a quarter of the planet from the truth.
        assert!(
            p.longitude.abs() > 179.0,
            "went the wrong way round: {}",
            p.longitude
        );
    }

    #[test]
    fn rejects_a_file_with_no_usable_points() {
        assert!(Track::parse("<gpx></gpx>").is_err());
        assert!(Track::parse("not xml at all").is_err());
        // Points without timestamps cannot be matched to photos, and must not
        // be presented as a usable track.
        let untimed = r#"<gpx><wpt lat="59" lon="10"><name>Home</name></wpt></gpx>"#;
        let err = Track::parse(untimed).unwrap_err();
        assert!(err.contains("timestamp"), "unhelpful: {err}");
    }

    #[test]
    fn accepts_waypoints_and_route_points() {
        let xml = r#"<gpx>
            <wpt lat="1" lon="1"><time>2024-06-15T09:00:00Z</time></wpt>
            <rte><rtept lat="2" lon="2"><time>2024-06-15T09:10:00Z</time></rtept></rte>
        </gpx>"#;
        assert_eq!(Track::parse(xml).unwrap().points.len(), 2);
    }

    #[test]
    fn parses_iso8601_variants() {
        let base = parse_iso8601("2024-06-15T09:41:00Z").unwrap();
        assert_eq!(parse_iso8601("2024-06-15T09:41:00").unwrap(), base);
        assert_eq!(parse_iso8601("2024-06-15 09:41:00Z").unwrap(), base);
        assert_eq!(parse_iso8601("2024-06-15T09:41:00.500Z").unwrap(), base);
        // A positive zone means local is ahead of UTC, so UTC is earlier.
        assert_eq!(parse_iso8601("2024-06-15T11:41:00+02:00").unwrap(), base);
        assert_eq!(parse_iso8601("2024-06-15T04:41:00-05:00").unwrap(), base);
        assert_eq!(parse_iso8601("nonsense"), None);
    }

    #[test]
    fn the_epoch_and_leap_years_are_right() {
        assert_eq!(parse_iso8601("1970-01-01T00:00:00Z").unwrap(), 0);
        assert_eq!(parse_iso8601("2000-03-01T00:00:00Z").unwrap(), 951_868_800);
        // 2024 is a leap year; 29 February must exist and be one day before
        // 1 March.
        let feb29 = parse_iso8601("2024-02-29T00:00:00Z").unwrap();
        let mar1 = parse_iso8601("2024-03-01T00:00:00Z").unwrap();
        assert_eq!(mar1 - feb29, 86_400);
        // 1900 was not a leap year, which is the case a naive rule gets wrong.
        let feb28_1900 = parse_iso8601("1900-02-28T00:00:00Z").unwrap();
        let mar1_1900 = parse_iso8601("1900-03-01T00:00:00Z").unwrap();
        assert_eq!(mar1_1900 - feb28_1900, 86_400);
    }

    #[test]
    fn exif_datetimes_round_trip_through_the_formatter() {
        for text in [
            "2024:06:15 09:41:00",
            "1970:01:01 00:00:00",
            "1999:12:31 23:59:59",
            "2024:02:29 12:00:00",
            "2000:03:01 00:00:00",
        ] {
            let parsed = parse_exif_datetime(text).unwrap();
            assert_eq!(format_exif_datetime(parsed), text, "round trip failed");
        }
    }

    #[test]
    fn shifting_a_date_crosses_day_month_and_year_boundaries() {
        let shift = |text: &str, seconds: i64| {
            format_exif_datetime(parse_exif_datetime(text).unwrap() + seconds)
        };
        // Backwards over midnight — the case a naive "subtract from the hour"
        // implementation gets wrong.
        assert_eq!(shift("2024:06:15 01:30:00", -3 * 3600), "2024:06:14 22:30:00");
        // Forwards over midnight, and over a month end.
        assert_eq!(shift("2024:06:30 23:00:00", 2 * 3600), "2024:07:01 01:00:00");
        // Over a year end.
        assert_eq!(shift("2023:12:31 23:00:00", 2 * 3600), "2024:01:01 01:00:00");
        // Into 29 February of a leap year.
        assert_eq!(shift("2024:02:28 23:00:00", 2 * 3600), "2024:02:29 01:00:00");
        // 1900 was not a leap year: 28 Feb + 1 day is 1 March.
        assert_eq!(shift("1900:02:28 12:00:00", 86_400), "1900:03:01 12:00:00");
    }

    #[test]
    fn dates_before_1970_do_not_land_a_day_out() {
        // Negative timestamps: truncating division would round towards zero and
        // put a scanned family photo on the wrong day.
        let text = "1965:03:07 14:20:00";
        let parsed = parse_exif_datetime(text).unwrap();
        assert!(parsed < 0);
        assert_eq!(format_exif_datetime(parsed), text);
    }

    #[test]
    fn parses_exif_datetime_and_offsets() {
        let dt = parse_exif_datetime("2024:06:15 09:41:00").unwrap();
        assert_eq!(dt, parse_iso8601("2024-06-15T09:41:00Z").unwrap());
        assert_eq!(parse_exif_datetime("nonsense"), None);
        // ExifTool writes 0000:00:00 for an unset date.
        assert_eq!(parse_exif_datetime("0000:00:00 00:00:00"), None);

        assert_eq!(parse_utc_offset("+02:00"), Some(7200));
        assert_eq!(parse_utc_offset("-05:00"), Some(-18_000));
        assert_eq!(parse_utc_offset("+05:30"), Some(19_800));
        assert_eq!(parse_utc_offset("Z"), Some(0));
        assert_eq!(parse_utc_offset("+99:00"), None);
        assert_eq!(parse_utc_offset("garbage"), None);
    }

    /* ── Matching ────────────────────────────────────────────────────────── */

    fn photo(path: &str, taken: &str) -> serde_json::Value {
        serde_json::json!({ "SourceFile": path, "EXIF:DateTimeOriginal": taken })
    }

    #[test]
    fn matches_photos_taken_during_the_track() {
        let track = Track::parse(SAMPLE).unwrap();
        // The track is UTC 09:00–09:20; these are local times at UTC+0.
        let entries = vec![photo("/a.jpg", "2024:06:15 09:05:00")];
        let matches = match_photos(&track, &entries, 0, DEFAULT_MAX_GAP_SECS);
        assert!(matches[0].matched());
        assert!(matches[0].reason.is_none());
    }

    #[test]
    fn the_camera_offset_is_used_when_present_and_beats_the_fallback() {
        let track = Track::parse(SAMPLE).unwrap();
        // Local 11:05 at UTC+02:00 is 09:05 UTC — inside the track.
        let entry = serde_json::json!({
            "SourceFile": "/a.jpg",
            "EXIF:DateTimeOriginal": "2024:06:15 11:05:00",
            "EXIF:OffsetTimeOriginal": "+02:00"
        });
        // The fallback is deliberately wrong. The camera's own value must win,
        // or a mixed-timezone trip could never be geotagged in one pass.
        let matches = match_photos(&track, &[entry], -18_000, DEFAULT_MAX_GAP_SECS);
        assert!(matches[0].matched(), "{:?}", matches[0].reason);
    }

    #[test]
    fn the_fallback_offset_shifts_unlabelled_photos() {
        let track = Track::parse(SAMPLE).unwrap();
        let entries = vec![photo("/a.jpg", "2024:06:15 11:05:00")];
        // Read as UTC, 11:05 is after the track ends at 09:20.
        let none = match_photos(&track, &entries, 0, DEFAULT_MAX_GAP_SECS);
        assert!(!none[0].matched());
        assert_eq!(none[0].reason, Some(NoMatch::AfterTrack));
        // At UTC+2 it lands inside.
        let some = match_photos(&track, &entries, 7200, DEFAULT_MAX_GAP_SECS);
        assert!(some[0].matched());
    }

    #[test]
    fn explains_precisely_why_each_photo_did_not_match() {
        let xml = r#"<gpx><trk><trkseg>
            <trkpt lat="59" lon="10"><time>2024-06-15T09:00:00Z</time></trkpt>
            <trkpt lat="59" lon="10"><time>2024-06-15T09:10:00Z</time></trkpt>
            <trkpt lat="60" lon="11"><time>2024-06-15T12:00:00Z</time></trkpt>
        </trkseg></trk></gpx>"#;
        let track = Track::parse(xml).unwrap();
        let entries = vec![
            photo("/before.jpg", "2024:06:15 06:00:00"),
            photo("/gap.jpg", "2024:06:15 10:30:00"),
            photo("/after.jpg", "2024:06:15 18:00:00"),
            serde_json::json!({ "SourceFile": "/undated.jpg" }),
        ];
        let matches = match_photos(&track, &entries, 0, DEFAULT_MAX_GAP_SECS);
        // "8 photos did not match" is not actionable; the user needs to know
        // whether to adjust the timezone, extend the track, or fix a clock.
        assert_eq!(matches[0].reason, Some(NoMatch::BeforeTrack));
        assert_eq!(matches[1].reason, Some(NoMatch::InsideGap));
        assert_eq!(matches[2].reason, Some(NoMatch::AfterTrack));
        assert_eq!(matches[3].reason, Some(NoMatch::NoCaptureTime));
        assert!(matches.iter().all(|m| !m.matched()));
    }

    /// The contract with `www/js/geotag.js`.
    ///
    /// The frontend reads these keys by name off the serialised preview. A
    /// rename on this side produces `undefined` over there — the summary would
    /// read "undefined of undefined photos match" and the Apply button would
    /// send positions that are not there, with nothing failing on either side.
    #[test]
    fn the_preview_json_matches_what_the_frontend_reads() {
        let track = Track::parse(SAMPLE).unwrap();
        let located = serde_json::json!({
            "SourceFile": "/has.jpg",
            "EXIF:DateTimeOriginal": "2024:06:15 09:05:00",
            "Composite:GPSLatitude": 1.0,
            "Composite:GPSLongitude": 2.0
        });
        let missed = photo("/late.jpg", "2024:06:15 23:00:00");
        let matches = match_photos(&track, &[located, missed], 0, DEFAULT_MAX_GAP_SECS);
        let preview = GeotagPreview::build(&track, matches);

        let json = serde_json::to_value(&preview).unwrap();
        // Exactly the keys grep finds in geotag.js.
        for key in [
            "matches",
            "matched",
            "wouldReplace",
            "trackPoints",
            "trackStart",
            "trackEnd",
        ] {
            assert!(json.get(key).is_some(), "preview is missing `{key}`");
        }
        assert_eq!(json["matched"], 1);
        assert_eq!(json["wouldReplace"], 1);
        assert_eq!(json["trackPoints"], 3);

        let entries = json["matches"].as_array().unwrap();
        assert!(entries[0].get("path").is_some(), "match is missing `path`");
        // A matched photo carries a position and no reason.
        assert!(entries[0].get("position").is_some());
        assert!(entries[0].get("reason").is_none());
        // An unmatched one is the other way round, and its reason must be one
        // of the strings geotag.js has wording for.
        assert!(entries[1].get("position").is_none());
        let reason = entries[1]["reason"].as_str().unwrap();
        assert!(
            ["noCaptureTime", "beforeTrack", "afterTrack", "insideGap"].contains(&reason),
            "unknown reason `{reason}` — geotag.js has no wording for it"
        );

        // The position is the shape the Apply command deserialises back.
        let position = &entries[0]["position"];
        assert!(position.get("latitude").is_some());
        assert!(position.get("longitude").is_some());
    }

    #[test]
    fn reports_which_photos_would_have_a_location_replaced() {
        let track = Track::parse(SAMPLE).unwrap();
        let located = serde_json::json!({
            "SourceFile": "/has.jpg",
            "EXIF:DateTimeOriginal": "2024:06:15 09:05:00",
            "Composite:GPSLatitude": 1.0,
            "Composite:GPSLongitude": 2.0
        });
        let bare = photo("/bare.jpg", "2024:06:15 09:05:00");
        let matches = match_photos(&track, &[located, bare], 0, DEFAULT_MAX_GAP_SECS);
        // Overwriting an existing fix is a different act from filling in a
        // blank, and the review has to be able to say which is which.
        assert!(matches[0].had_position);
        assert!(!matches[1].had_position);
    }
}
