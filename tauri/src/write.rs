//! The write path.
//!
//! This is the part of the app that can destroy someone's photographs, so the
//! shape is deliberately conservative:
//!
//! ```text
//!   copy original → temp (same directory)
//!   edit the temp with ExifTool
//!   re-read the temp and confirm the tags actually took
//!   fsync the temp
//!   rename temp over the original   (atomic)
//!   fsync the parent directory
//! ```
//!
//! **The original is never opened for writing.** A crash at any point leaves
//! either the old file or the new one, never a half-written one, because the
//! only mutation of the destination is a rename — which POSIX and NTFS both
//! make atomic.
//!
//! The temp lives in the *same directory* as the original so the rename cannot
//! cross a filesystem boundary. That rules out `EXDEV` entirely, and with it
//! the copy-based fallback that would reintroduce a window where the
//! destination is truncated.
//!
//! Verification is not paranoia about ExifTool. It is that a write can be
//! reported as successful and still not take — a tag can be silently ignored
//! for a format that does not support it, and a GPS reference written as its
//! documented enum is accepted and then stored wrong (see `library::GpsPosition`).
//! Re-reading is the only way to know.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use crate::exiftool::ExifToolSession;
use crate::library::{self, GpsPosition};

/* ══════════════════════════════════════════════════════════════════════════
   SERIALISING MUTATIONS
══════════════════════════════════════════════════════════════════════════ */

/// Held for the whole of any operation that changes files on disk.
///
/// # Why this exists
///
/// Everything below was written when exactly one mutation could be in flight:
/// the Tauri commands were synchronous, so they ran one at a time on the UI
/// thread, and the Electron sidecar reads stdin in a single loop. Neither is a
/// guarantee anyone wrote down, and the first — the accidental one — had to go,
/// because a two-hundred-file batch froze the window while it ran.
///
/// Taking it away without this lock would have been worse than the freeze.
/// Two overlapping batches share one undo store, and `UndoBatch::begin` opens
/// by deleting it:
///
/// ```text
///   batch A  begin ── snapshot a.jpg, b.jpg ─────── finish (writes manifest)
///   batch B          begin  ← removes the store, and A's snapshots with it
/// ```
///
/// A then names snapshots that are gone, and undoing reports "the saved copy
/// is missing" for every file it promised to restore. `sweep_stale_temps` is
/// the same shape from the other side: it deletes `.revery_exif.tmp` siblings,
/// which is exactly what a concurrent write has staged and not yet renamed.
///
/// So the invariant is stated here rather than inherited from whichever thread
/// happened to call: **one mutating operation at a time, per process.** Reads
/// are unaffected and stay concurrent; they are serialised further down by the
/// single ExifTool session anyway.
///
/// Process-wide rather than per-folder because the things being protected are
/// process-wide: one undo store at a time, one engine, one temp-file namespace.
static MUTATION_LOCK: Mutex<()> = Mutex::new(());

/// Takes the mutation lock, recovering from a panic in a previous holder.
///
/// Poisoning is not useful here. The lock guards no shared in-memory state —
/// every operation under it re-reads the filesystem — so a panicked predecessor
/// leaves nothing for the next caller to misread. Propagating the poison would
/// only turn one failed write into a permanently unusable app.
pub(crate) fn lock_mutations() -> MutexGuard<'static, ()> {
    MUTATION_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/* ══════════════════════════════════════════════════════════════════════════
   FIELD DEFINITIONS
══════════════════════════════════════════════════════════════════════════ */

/// One curated field, and every tag it writes.
///
/// A value is written to **all** of `write_tags`. The same human concept lives
/// in EXIF, IPTC and XMP under different names, and software reads whichever it
/// prefers — a title stored only in XMP is invisible in a great deal of it.
///
/// `verify_tag` is read back afterwards to confirm the write landed. It is the
/// first entry of `write_tags` by convention.
///
/// Kept in step with `FIELDS` in `www/js/state.js`, which lists the same tags
/// in read priority order. The list here is authoritative for writing; the
/// test `field_specs_match_the_frontend` pins the tag strings so a change on
/// either side has to be deliberate.
pub struct FieldSpec {
    pub key: &'static str,
    pub write_tags: &'static [&'static str],
    pub verify_tag: &'static str,
    pub list: bool,
}

pub const FIELD_SPECS: &[FieldSpec] = &[
    FieldSpec {
        key: "title",
        write_tags: &["XMP:Title", "IPTC:ObjectName"],
        verify_tag: "XMP:Title",
        list: false,
    },
    FieldSpec {
        key: "description",
        write_tags: &[
            "XMP:Description",
            "IPTC:Caption-Abstract",
            "EXIF:ImageDescription",
        ],
        verify_tag: "XMP:Description",
        list: false,
    },
    FieldSpec {
        key: "keywords",
        write_tags: &["XMP:Subject", "IPTC:Keywords"],
        verify_tag: "XMP:Subject",
        list: true,
    },
    FieldSpec {
        key: "creator",
        write_tags: &["XMP:Creator", "IPTC:By-line", "EXIF:Artist"],
        verify_tag: "XMP:Creator",
        list: true,
    },
    FieldSpec {
        key: "copyright",
        write_tags: &["XMP:Rights", "IPTC:CopyrightNotice", "EXIF:Copyright"],
        verify_tag: "XMP:Rights",
        list: false,
    },
    FieldSpec {
        key: "dateTaken",
        // CreateDate as well as DateTimeOriginal: "date taken" means both to
        // most software, and leaving them disagreeing is how a library ends up
        // sorting a photo into two different days depending on the viewer.
        // ModifyDate is deliberately left alone — it means "file last changed",
        // which this edit genuinely is.
        write_tags: &[
            "EXIF:DateTimeOriginal",
            "EXIF:CreateDate",
            "XMP:DateTimeOriginal",
        ],
        verify_tag: "EXIF:DateTimeOriginal",
        list: false,
    },
    FieldSpec {
        key: "rating",
        write_tags: &["XMP:Rating"],
        verify_tag: "XMP:Rating",
        list: false,
    },
];

fn spec_for(key: &str) -> Option<&'static FieldSpec> {
    FIELD_SPECS.iter().find(|s| s.key == key)
}

/* ══════════════════════════════════════════════════════════════════════════
   TAG POLICY

   Which arbitrary tags the All tab may edit, and why not when it may not.

   This is the authority for the whole app. It is enforced here rather than in
   the frontend because the IPC boundary is not trusted — `state.js` mirrors
   the list only to decide whether to draw a button, and a cross-source test
   pins the two together.
══════════════════════════════════════════════════════════════════════════ */

/// Groups whose tags are not real, writable metadata.
///
/// `Composite` is derived by ExifTool from other tags and has no storage of
/// its own; `File` and `System` describe the container and the filesystem;
/// `ExifTool` is the reader's own bookkeeping. Writing any of them is either
/// an error or silently does nothing, and offering it would be a lie.
const UNWRITABLE_GROUPS: &[(&str, &str)] = &[
    ("Composite", "worked out from other tags, so there is nothing to write"),
    ("File", "describes the file container, not the photo"),
    ("System", "belongs to the filesystem, not the photo"),
    ("ExifTool", "ExifTool's own notes about reading the file"),
];

/// Groups that are real metadata but must not be edited a tag at a time.
const LOCKED_GROUPS: &[(&str, &str)] = &[
    ("ICC_Profile", "part of how the colours are decoded"),
    ("JFIF", "part of how the file is decoded"),
    (
        "MakerNotes",
        "a block written by the camera; changing single entries in it corrupts the rest",
    ),
];

/// Tag names — group prefix ignored — that tell a viewer how to decode and
/// present the pixels.
///
/// **This is the list the strip path has always implied.** `-all=` followed by
/// re-adding `-icc_profile` and `-Orientation` is the same promise made in two
/// lines of argument building; `StripEdit::Everything` now reads its
/// re-add list from here so the two cannot drift.
///
/// The distinction being drawn is the one already stated in `verify`: metadata
/// *about* the photo — who took it, where, when — versus metadata that
/// describes how to turn the bytes back into a picture. The first is the
/// user's to edit. The second is not, because getting it wrong produces a
/// photo that is sideways, wrongly coloured, or will not open at all.
const RENDER_CRITICAL: &[(&str, &str)] = &[
    ("Orientation", "kept so the photo displays the right way up"),
    // Colour. Without these a viewer has no way to interpret the samples.
    ("ColorSpace", "describes how to decode the colours"),
    ("WhitePoint", "describes how to decode the colours"),
    ("PrimaryChromaticities", "describes how to decode the colours"),
    ("TransferFunction", "describes how to decode the colours"),
    ("ReferenceBlackWhite", "describes how to decode the colours"),
    ("YCbCrCoefficients", "describes how to decode the colours"),
    ("YCbCrPositioning", "describes how to decode the colours"),
    ("YCbCrSubSampling", "describes how to decode the colours"),
    // Sample layout.
    ("BitsPerSample", "describes how to decode the pixels"),
    ("Compression", "describes how to decode the pixels"),
    ("PhotometricInterpretation", "describes how to decode the pixels"),
    ("SamplesPerPixel", "describes how to decode the pixels"),
    ("PlanarConfiguration", "describes how to decode the pixels"),
    ("RowsPerStrip", "describes how to decode the pixels"),
    // Dimensions.
    ("ImageWidth", "describes the size of the picture"),
    ("ImageHeight", "describes the size of the picture"),
    ("ImageLength", "describes the size of the picture"),
    ("ExifImageWidth", "describes the size of the picture"),
    ("ExifImageHeight", "describes the size of the picture"),
    // Format markers. Editing one makes the block unreadable rather than wrong.
    ("ExifVersion", "says which version of the format this is"),
    ("FlashpixVersion", "says which version of the format this is"),
    ("InteropIndex", "says which version of the format this is"),
    ("InteropVersion", "says which version of the format this is"),
];

/// Tag names that are byte positions or lengths inside the file.
///
/// Checked by suffix. Any write that adds or removes metadata shifts
/// everything after the insertion point, so ExifTool maintains these itself —
/// a hand-edited value points at the wrong bytes and takes the embedded
/// thumbnail or preview with it. The same reasoning is already written down in
/// `is_incidental` in `tests/write_path.rs`, which excuses these tags from the
/// "nothing else changed" comparison for exactly this reason.
/// Suffixes only — `StripOffsets`, `TileByteCounts`, `ThumbnailOffset`.
const POINTER_SUFFIXES: &[&str] = &["Offset", "Offsets", "ByteCounts"];

/// Whole names, because the obvious suffix would over-reach.
///
/// `Length` cannot be a suffix rule: `FocalLength` and `FocalLengthIn35mmFormat`
/// are ordinary photographic metadata and must stay editable. Nor can `Start`.
/// So the embedded-image pointers are listed out in full.
const POINTER_NAMES: &[&str] = &[
    "ThumbnailOffset",
    "ThumbnailLength",
    "PreviewImageStart",
    "PreviewImageLength",
    "JpgFromRawStart",
    "JpgFromRawLength",
    "OtherImageStart",
    "OtherImageLength",
];

/// The tags `StripEdit::Everything` puts back after `-all=`.
///
/// Reads from the same policy as everything else: these are the render-critical
/// families ExifTool can restore wholesale with `-tagsfromfile @`. Not every
/// entry in `RENDER_CRITICAL` belongs here — the structural EXIF fields live in
/// the IFD that `-all=` rebuilds anyway, whereas orientation and the colour
/// profile are genuinely lost without an explicit re-add.
const STRIP_PRESERVES: &[&str] = &["-icc_profile", "-Orientation"];

/// Splits `EXIF:Artist` into its group and name.
fn split_tag(tag: &str) -> (&str, &str) {
    match tag.split_once(':') {
        Some((group, name)) => (group, name),
        None => ("", tag),
    }
}

/// Why this tag may not be edited, or `None` when it may.
///
/// The reason is shown to the user next to the locked row, so it is written as
/// a sentence fragment completing "…this tag is <reason>" rather than as an
/// error code. Someone who wonders why they cannot delete `Orientation`
/// deserves an answer, not a greyed-out button.
pub fn locked_reason(tag: &str) -> Option<&'static str> {
    let (group, name) = split_tag(tag);

    if tag == "SourceFile" {
        return Some("the path the file was read from, not metadata in it");
    }
    if let Some((_, why)) = UNWRITABLE_GROUPS.iter().find(|(g, _)| *g == group) {
        return Some(why);
    }
    if let Some((_, why)) = LOCKED_GROUPS.iter().find(|(g, _)| *g == group) {
        return Some(why);
    }
    if let Some((_, why)) = RENDER_CRITICAL.iter().find(|(n, _)| *n == name) {
        return Some(why);
    }
    if POINTER_SUFFIXES.iter().any(|s| name.ends_with(s))
        || POINTER_NAMES.contains(&name)
    {
        return Some("a position inside the file rather than a value");
    }
    None
}

/// Rejects anything that is not a plain `Group:Name` tag.
///
/// The name is interpolated straight into `-{tag}=`, so a value carrying `=`,
/// a leading `-`, or one of ExifTool's wildcards would stop being a tag
/// assignment and start being an *option*. `-GPS*=` and `-all=` are real
/// commands this app issues deliberately elsewhere; arriving over IPC as a tag
/// name they would be a way to wipe a file through a feature that advertises
/// editing one field.
///
/// The group is required rather than inferred. A bare `Artist` leaves ExifTool
/// to choose a namespace, and the tag the user then sees in the inspector may
/// not be the one they thought they were editing.
fn validate_tag_name(tag: &str) -> Result<(), String> {
    let (group, name) = split_tag(tag);
    let ok = |s: &str| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    };
    if !tag.contains(':') {
        return Err(format!(
            "{tag} does not say which group it belongs to. Use a name like EXIF:Artist."
        ));
    }
    if !ok(group) || !ok(name) {
        return Err(format!("{tag} is not a tag name this app will write."));
    }
    Ok(())
}

/* ══════════════════════════════════════════════════════════════════════════
   THE EDIT
══════════════════════════════════════════════════════════════════════════ */

/// What to do with one field.
///
/// Three states, and the third is the point: a field absent from the request
/// is **left alone**, which is different from being cleared. Collapsing those
/// two is the classic batch-metadata bug — it turns "I only changed the
/// copyright" into "I also wiped every title in the selection".
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum FieldEdit {
    Set { value: serde_json::Value },
    Clear,
}

/// What to do with one arbitrary tag named in full, e.g. `EXIF:UserComment`.
///
/// Deliberately a separate type from `FieldEdit` even though the shapes match.
/// A curated field fans one value out across EXIF, IPTC and XMP and verifies
/// through a chosen tag; a raw tag is exactly itself. Sharing the type would
/// invite sharing the code, and the two need different argument forms — see
/// `write_args`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum TagEdit {
    Set { value: serde_json::Value },
    Clear,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum GpsEdit {
    Set { position: GpsPosition },
    Clear,
}

/// Moves every timestamp by the same amount — the "the camera clock was three
/// hours off" repair.
///
/// ExifTool does the arithmetic (`-AllDates+=`), because it shifts each tag by
/// *its own* value and so preserves a genuine difference between, say,
/// DateTimeOriginal and CreateDate. The app predicts the result independently
/// and refuses the write if the two disagree, which keeps the preview honest
/// without reimplementing the shift.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum DateEdit {
    Shift { seconds: i64 },
}

/// Removes metadata before publishing.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StripEdit {
    /// Coordinates only, across every namespace.
    Location,
    /// Everything except what the image needs to *display* correctly.
    Everything,
}

/// A set of changes to apply to one file. Absent fields are left untouched.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PhotoEdit {
    #[serde(default, flatten)]
    pub fields: std::collections::BTreeMap<String, FieldEdit>,
    /// Arbitrary tags from the All tab, keyed by full `Group:Name`.
    ///
    /// A named field rather than part of the flattened map above, which would
    /// have taken these for free. Two reasons. Serde resolves named fields
    /// before the flatten catch-all, so `"tags"` routes here and no curated
    /// key is shadowed. And keeping the key spaces apart is what makes the
    /// collision check in `write_args` possible at all — with one map,
    /// `title` and `XMP:Title` are two unrelated keys that happen to write the
    /// same tag, and `BTreeMap` ordering silently decides which one wins.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub tags: std::collections::BTreeMap<String, TagEdit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gps: Option<GpsEdit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dates: Option<DateEdit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strip: Option<StripEdit>,
}

impl PhotoEdit {
    pub fn is_empty(&self) -> bool {
        self.fields.is_empty()
            && self.tags.is_empty()
            && self.gps.is_none()
            && self.dates.is_none()
            && self.strip.is_none()
    }

    /// The ExifTool arguments for this edit.
    pub fn write_args(&self) -> Result<Vec<String>, String> {
        let mut args = Vec::new();

        self.check_no_tag_collisions()?;

        for (key, edit) in &self.fields {
            let spec = spec_for(key).ok_or_else(|| format!("Unknown field: {key}"))?;
            match edit {
                FieldEdit::Clear => {
                    // `-TAG=` with no value deletes the tag.
                    for tag in spec.write_tags {
                        args.push(format!("-{tag}="));
                    }
                }
                FieldEdit::Set { value } => {
                    let values = normalise(value, spec)?;
                    for tag in spec.write_tags {
                        // Clear first, then add each value. Without the clear,
                        // writing a list *appends* to what is already there,
                        // so editing keywords would keep accumulating the old
                        // ones instead of replacing them.
                        args.push(format!("-{tag}="));
                        for item in &values {
                            args.push(format!("-{tag}={item}"));
                        }
                    }
                }
            }
        }

        // Stripping comes first: it is a wholesale delete, and anything the
        // user also asked to set should land on top of the cleared file rather
        // than be wiped by it.
        match self.strip {
            Some(StripEdit::Location) => args.push("-GPS*=".into()),
            Some(StripEdit::Everything) => {
                args.push("-all=".into());
                // …then put back the things that are not metadata *about* the
                // photo but part of displaying it correctly. Without this, a
                // photo shot in portrait comes out sideways in every viewer,
                // and its colours shift. `@` means "from this same file", read
                // before the delete.
                //
                // The list comes from `STRIP_PRESERVES` rather than being
                // spelled out here, so "what the image needs to render" has one
                // definition that this path and `locked_reason` both answer to.
                args.push("-tagsfromfile".into());
                args.push("@".into());
                args.extend(STRIP_PRESERVES.iter().map(|t| (*t).to_string()));
            }
            None => {}
        }

        if let Some(DateEdit::Shift { seconds }) = self.dates {
            if seconds != 0 {
                let magnitude = seconds.unsigned_abs();
                let sign = if seconds < 0 { "-=" } else { "+=" };
                let value = format!(
                    "{}:{}:{}",
                    magnitude / 3600,
                    (magnitude % 3600) / 60,
                    magnitude % 60
                );
                // AllDates covers DateTimeOriginal, CreateDate and ModifyDate,
                // shifting only the ones that are present.
                args.push(format!("-AllDates{sign}{value}"));
                args.push(format!("-XMP:DateTimeOriginal{sign}{value}"));
            }
        }

        match &self.gps {
            Some(GpsEdit::Clear) => {
                // `-GPS*=` and not `-gps:all=`: the latter clears the EXIF GPS
                // block and leaves XMP GPS sitting in the file untouched, so a
                // photo "stripped" before publishing still carries its
                // coordinates. Verified against the binary.
                args.push("-GPS*=".into());
            }
            Some(GpsEdit::Set { position }) => {
                if !position.is_valid() {
                    return Err(format!(
                        "Refusing to write an out-of-range position: {}, {}",
                        position.latitude, position.longitude
                    ));
                }
                args.extend(position.write_args());
            }
            None => {}
        }

        // Arbitrary tags land last, so a tag the user named explicitly wins
        // over a wholesale strip or a curated field that happened to touch the
        // same area of the file. Naming a tag is the most specific thing a user
        // can do, and it should behave that way.
        for (tag, edit) in &self.tags {
            args.extend(tag_write_args(tag, edit)?);
        }

        Ok(args)
    }

    /// Refuses an edit where a curated field and a raw tag write the same tag.
    ///
    /// `{ "title": …, "tags": { "XMP:Title": … } }` asks for two different
    /// values in one place. Applying both would leave whichever ExifTool saw
    /// last, which from the user's side looks like the app ignoring one of
    /// their edits at random. Refusing costs them one retry and tells them why.
    fn check_no_tag_collisions(&self) -> Result<(), String> {
        for key in self.fields.keys() {
            let Some(spec) = spec_for(key) else { continue };
            for written in spec.write_tags {
                if self.tags.contains_key(*written) {
                    return Err(format!(
                        "The {key} field and the tag {written} both write to \
                         {written}. Change one of them, not both."
                    ));
                }
            }
        }
        Ok(())
    }
}

/// ExifTool arguments for one arbitrary tag.
///
/// **Every assignment carries the `#` suffix, and that is the whole point of
/// this function.** Metadata is read back with `-n`, which turns off print
/// conversion, so the inspector shows machine values: `Orientation` reads as
/// `6`, not `Rotate 90 CW`. Writing that `6` back as `-Orientation=6` sends it
/// through the *inverse* conversion, where ExifTool tries to interpret `6` as
/// a human-readable string and stores something else — or accepts it, reports
/// success, and stores nothing, which is the documented behaviour of
/// `-GPSAltitudeRef=1` recorded in `library::GpsPosition`.
///
/// `-Orientation#=6` is ExifTool's own documented equivalent of
/// `-Orientation=6 -n`, so it round-trips exactly what the user was shown.
/// Without it this whole feature is a way to silently corrupt tags.
///
/// Deletion uses the bare `-{tag}=` form: there is no value to convert, and
/// `#` on an empty assignment is meaningless.
fn tag_write_args(tag: &str, edit: &TagEdit) -> Result<Vec<String>, String> {
    validate_tag_name(tag)?;
    if let Some(reason) = locked_reason(tag) {
        return Err(format!("{tag} cannot be changed: it is {reason}."));
    }

    Ok(match edit {
        TagEdit::Clear => vec![format!("-{tag}=")],
        TagEdit::Set { value } => {
            let values = normalise_tag_value(tag, value)?;
            // Clear first, then add each value — the same rule the curated
            // fields follow, and for the same reason: ExifTool *appends* to a
            // list-valued tag, so without the clear an edit accumulates the old
            // values instead of replacing them.
            let mut args = vec![format!("-{tag}#=")];
            args.extend(values.into_iter().map(|v| format!("-{tag}#={v}")));
            args
        }
    })
}

/// Coerces an arbitrary tag's JSON value into the strings ExifTool is given.
///
/// Looser than `normalise` for curated fields, which knows whether its field is
/// a list. Nothing knows that for an arbitrary tag — reads are deliberately not
/// `-struct`, so a single-valued list tag and a scalar look identical in the
/// JSON — so an array is simply written as several values and ExifTool decides
/// whether that is legal.
///
/// A binary value is refused. The inspector renders those as
/// `(binary, N bytes encoded)`, which is a summary rather than a value; letting
/// it round-trip would write that sentence into the file as text.
fn normalise_tag_value(tag: &str, value: &serde_json::Value) -> Result<Vec<String>, String> {
    let one = |v: &serde_json::Value| -> Result<String, String> {
        match v {
            serde_json::Value::String(s) => {
                if s.starts_with("base64:") || s.starts_with("(binary,") {
                    return Err(format!(
                        "{tag} holds binary data, which this app will not edit as text."
                    ));
                }
                Ok(s.clone())
            }
            serde_json::Value::Number(n) => Ok(n.to_string()),
            serde_json::Value::Bool(b) => Ok(b.to_string()),
            other => Err(format!("{tag} cannot take the value {other}")),
        }
    };
    match value {
        serde_json::Value::Array(items) => items.iter().map(one).collect(),
        other => Ok(vec![one(other)?]),
    }
}

/// Coerces a JSON value into the strings ExifTool will be given.
fn normalise(value: &serde_json::Value, spec: &FieldSpec) -> Result<Vec<String>, String> {
    let one = |v: &serde_json::Value| -> Result<String, String> {
        match v {
            serde_json::Value::String(s) => Ok(s.clone()),
            serde_json::Value::Number(n) => Ok(n.to_string()),
            serde_json::Value::Bool(b) => Ok(b.to_string()),
            other => Err(format!(
                "Field {} cannot take the value {other}",
                spec.key
            )),
        }
    };
    match value {
        serde_json::Value::Array(items) => {
            if !spec.list {
                return Err(format!("Field {} does not take a list", spec.key));
            }
            items.iter().map(one).collect()
        }
        other => Ok(vec![one(other)?]),
    }
}

/* ══════════════════════════════════════════════════════════════════════════
   APPLYING
══════════════════════════════════════════════════════════════════════════ */

/// What a completed write did, for the UI and the undo log.
#[derive(Debug, Clone, Serialize)]
pub struct WriteOutcome {
    pub path: String,
    /// Warnings ExifTool raised that were not fatal. Common and usually
    /// harmless, but worth surfacing rather than swallowing.
    pub warnings: Vec<String>,
}

/// Applies `edit` to `path`, atomically, verifying the result before it lands.
///
/// `root` bounds the operation: `path` must resolve inside it.
pub fn apply_edit(
    session: &ExifToolSession,
    root: &Path,
    path: &str,
    edit: &PhotoEdit,
) -> Result<WriteOutcome, String> {
    let _mutations = lock_mutations();
    let target = library::resolve_within(root, path)?;
    if edit.is_empty() {
        return Ok(WriteOutcome {
            path: target.to_string_lossy().into_owned(),
            warnings: Vec::new(),
        });
    }
    let args = edit.write_args()?;
    // An edit that resolves to no arguments — a zero-second date shift, say —
    // is a no-op. Running ExifTool with no tag assignments would rewrite the
    // file to achieve exactly nothing.
    if args.is_empty() {
        return Err("There are no changes to apply.".into());
    }

    preflight(&target)?;

    let temp = temp_path_for(&target);
    // Any early return from here on must not leave the temp behind.
    let result = write_through_temp(session, &target, &temp, &args, edit);
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

/// Fails before anything is copied if the write cannot succeed.
///
/// A batch of 200 files should fail on the first one, not on the 137th with
/// half the library already modified.
fn preflight(target: &Path) -> Result<(), String> {
    let meta = std::fs::metadata(target)
        .map_err(|e| format!("Cannot read {}: {e}", target.display()))?;
    if !meta.is_file() {
        return Err(format!("Not a file: {}", target.display()));
    }
    if meta.permissions().readonly() {
        return Err(format!("{} is read-only", target.display()));
    }
    let parent = target
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", target.display()))?;
    check_parent_writable(parent)
}

/// Confirms a sibling file can be created next to the original.
///
/// The write lands by renaming a temp over the target, so what actually has to
/// be true is "I can create a file in this directory" — and the two platforms
/// answer that question differently enough to need separate code.
///
/// On Unix the directory's write permission means what it says.
///
/// On Windows `Permissions::readonly()` is nothing but `FILE_ATTRIBUTE_READONLY`,
/// and on a *directory* that bit does not mean "unwritable" at all — Windows
/// sets it to mark a folder as customised, i.e. one carrying a `desktop.ini`.
/// Pictures, Documents and Desktop all have it, as does any folder someone has
/// given an icon. Trusting it there refuses to save into very nearly every real
/// photo folder, and does so from `apply_per_file`'s pre-flight, which aborts
/// the whole batch before a single file is touched.
///
/// So Windows is asked the question it can answer: create the file and remove
/// it. That also catches an ACL denial, which the attribute bit never reflected
/// on either platform.
#[cfg(unix)]
fn check_parent_writable(parent: &Path) -> Result<(), String> {
    let meta = std::fs::metadata(parent)
        .map_err(|e| format!("Cannot read the folder {}: {e}", parent.display()))?;
    if meta.permissions().readonly() {
        return Err(format!(
            "The folder {} is read-only, so the file cannot be replaced",
            parent.display()
        ));
    }
    Ok(())
}

#[cfg(not(unix))]
fn check_parent_writable(parent: &Path) -> Result<(), String> {
    std::fs::metadata(parent)
        .map_err(|e| format!("Cannot read the folder {}: {e}", parent.display()))?;
    // Borrows the real temp naming, so the probe is hidden, unique per process,
    // ignored by `scan_folder`, and swept by `sweep_stale_temps` if a crash
    // lands between the create and the remove.
    let probe = temp_path_for(&parent.join("preflight"));
    std::fs::File::create(&probe).map_err(|e| {
        format!(
            "The folder {} cannot be written to, so the file cannot be replaced: {e}",
            parent.display()
        )
    })?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

/// A sibling temp name, so the later rename stays on one filesystem.
///
/// The `.tmp` extension keeps it out of `scan_folder`, which only lists known
/// image extensions — a half-written temp must never appear in the grid.
fn temp_path_for(target: &Path) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let name = format!(
        ".{}.{}.{}.revery_exif.tmp",
        target
            .file_name()
            .unwrap_or_default()
            .to_string_lossy(),
        std::process::id(),
        nanos
    );
    target.with_file_name(name)
}

fn write_through_temp(
    session: &ExifToolSession,
    target: &Path,
    temp: &Path,
    args: &[String],
    edit: &PhotoEdit,
) -> Result<WriteOutcome, String> {
    // 1. Copy. The original is now untouched for the rest of the operation.
    std::fs::copy(target, temp)
        .map_err(|e| format!("Could not stage a copy of {}: {e}", target.display()))?;

    // A date shift is arithmetic ExifTool performs, so predicting the result
    // needs the value as it stands *before* the edit.
    let expected_date = match edit.dates {
        Some(DateEdit::Shift { seconds }) => {
            let before = library::read_metadata(session, &[temp.to_path_buf()])?;
            before
                .get(0)
                .and_then(|e| e.get("EXIF:DateTimeOriginal"))
                .and_then(|v| v.as_str())
                .and_then(crate::gpx::parse_exif_datetime)
                .map(|t| crate::gpx::format_exif_datetime(t + seconds))
        }
        None => None,
    };

    // 2. Edit the copy. `-overwrite_original` because the copy *is* the
    //    backup; letting ExifTool leave its own `_original` alongside would
    //    litter the user's folder with files the app never cleans up.
    let mut full = vec!["-overwrite_original".to_string(), "-charset".into(), "UTF8".into()];
    full.extend(args.iter().cloned());
    full.push(temp.to_string_lossy().into_owned());

    let response = session.execute(&full)?;
    if response.has_error() {
        return Err(response.error_text());
    }

    // 3. Verify. A silently-ignored tag is the failure that matters, and it
    //    costs one read to rule out.
    verify(session, temp, edit, expected_date.as_deref())?;

    // 4. Flush the temp's contents to disk before the rename. Without this,
    //    power loss just after the rename can leave the destination name
    //    pointing at a file whose data never reached the platter.
    flush_to_disk(temp)?;

    // 5. The only mutation of the destination, and it is atomic. Same
    //    directory, so EXDEV is impossible and there is no copy fallback.
    std::fs::rename(temp, target)
        .map_err(|e| format!("Could not replace {}: {e}", target.display()))?;

    // 6. Persist the directory entry, so the rename itself survives a crash.
    sync_parent_dir(target);

    Ok(WriteOutcome {
        path: target.to_string_lossy().into_owned(),
        warnings: response
            .stderr
            .lines()
            .filter(|l| l.trim_start().starts_with("Warning:"))
            .map(|l| l.trim().to_string())
            .collect(),
    })
}

/// Forces a file's contents out to the disk itself.
///
/// **Opened for writing even though nothing more is written**, and that is the
/// whole point of the function existing separately. `sync_all` is `fsync` on
/// Unix, which is happy with a read-only descriptor — but on Windows it is
/// `FlushFileBuffers`, which requires a handle carrying `GENERIC_WRITE` and
/// fails with `Access is denied. (os error 5)` on the read-only handle
/// `File::open` hands back. The result was a write path that worked perfectly
/// on Linux and failed on Windows for every file, at the last step before the
/// rename, with the original untouched and no clue as to why.
///
/// `.write(true)` opens an existing file for writing without creating or
/// truncating it, so this observes the staged bytes rather than disturbing
/// them.
fn flush_to_disk(path: &Path) -> Result<(), String> {
    let file = std::fs::OpenOptions::new()
        .write(true)
        .open(path)
        .map_err(|e| format!("Cannot reopen the staged file: {e}"))?;
    file.sync_all()
        .map_err(|e| format!("Could not flush the staged file to disk: {e}"))
}

/// Re-reads the edited file and confirms every requested change is present.
fn verify(
    session: &ExifToolSession,
    temp: &Path,
    edit: &PhotoEdit,
    expected_date: Option<&str>,
) -> Result<(), String> {
    let read = library::read_metadata(session, &[temp.to_path_buf()])?;
    let entry = read
        .get(0)
        .ok_or("Could not re-read the file after writing it")?;

    for (key, field_edit) in &edit.fields {
        let spec = spec_for(key).ok_or_else(|| format!("Unknown field: {key}"))?;
        let actual = entry.get(spec.verify_tag);
        match field_edit {
            FieldEdit::Clear => {
                if actual.is_some_and(|v| !is_blank(v)) {
                    return Err(format!(
                        "Verification failed: {key} was still {actual:?} after being cleared"
                    ));
                }
            }
            FieldEdit::Set { value } => {
                let expected = normalise(value, spec)?;
                let got = as_strings(actual);
                if got != expected {
                    return Err(format!(
                        "Verification failed: {key} was written as {expected:?} \
                         but reads back as {got:?}"
                    ));
                }
            }
        }
    }

    for (tag, tag_edit) in &edit.tags {
        let actual = entry.get(tag.as_str());
        match tag_edit {
            TagEdit::Clear => {
                if actual.is_some_and(|v| !is_blank(v)) {
                    return Err(format!(
                        "Verification failed: {tag} was still {actual:?} after being cleared"
                    ));
                }
            }
            TagEdit::Set { value } => {
                let expected = normalise_tag_value(tag, value)?;
                let got = as_strings(actual);
                if !values_agree(&expected, &got) {
                    return Err(format!(
                        "Verification failed: {tag} was written as {expected:?} \
                         but reads back as {got:?}"
                    ));
                }
            }
        }
    }

    // The app's own prediction against ExifTool's arithmetic. They agreeing is
    // what lets the preview promise a specific new timestamp; if they ever
    // diverge the write is refused rather than silently landing something the
    // user did not review.
    if let Some(expected) = expected_date {
        let actual = entry
            .get("EXIF:DateTimeOriginal")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        if actual != expected {
            return Err(format!(
                "Verification failed: the date shift was predicted to give \
                 {expected} but produced {actual}"
            ));
        }
    }

    match edit.strip {
        Some(StripEdit::Location) => {
            if library::position_from_metadata(entry).is_some() {
                return Err("Verification failed: the location survived being stripped".into());
            }
        }
        Some(StripEdit::Everything) => {
            // What is checked is that nothing *identifying* remains — not that
            // the file has no tags at all. A stripped JPEG legitimately keeps
            // structural EXIF such as YCbCrPositioning and the resolution
            // fields, which describe how to decode the picture rather than who
            // took it or where. Asserting a bare tag count would fail on those
            // and say nothing about privacy.
            let leftovers: Vec<&String> = entry
                .as_object()
                .map(|map| {
                    map.keys()
                        .filter(|k| {
                            k.starts_with("XMP")
                                || k.starts_with("IPTC")
                                || k.starts_with("MakerNote")
                                || k.contains("GPS")
                                || IDENTIFYING_TAGS.iter().any(|t| k.ends_with(t))
                        })
                        .collect()
                })
                .unwrap_or_default();
            if !leftovers.is_empty() {
                return Err(format!(
                    "Verification failed: identifying metadata survived being \
                     stripped: {leftovers:?}"
                ));
            }
            if library::position_from_metadata(entry).is_some() {
                return Err("Verification failed: the location survived being stripped".into());
            }
        }
        None => {}
    }

    match &edit.gps {
        Some(GpsEdit::Clear) => {
            if library::position_from_metadata(entry).is_some() {
                return Err("Verification failed: the location was still present \
                            after being cleared"
                    .to_string());
            }
        }
        Some(GpsEdit::Set { position }) => {
            let actual = library::position_from_metadata(entry).ok_or(
                "Verification failed: no location was present after writing one",
            )?;
            // EXIF stores coordinates as rationals, so an exact float match is
            // not available. A ten-thousandth of a degree is about 11 m —
            // far tighter than any camera's fix, and loose enough to survive
            // the rational round-trip.
            if (actual.latitude - position.latitude).abs() > 1e-4
                || (actual.longitude - position.longitude).abs() > 1e-4
            {
                return Err(format!(
                    "Verification failed: wrote {}, {} but read back {}, {}",
                    position.latitude, position.longitude, actual.latitude, actual.longitude
                ));
            }
            if let Some(expected) = position.altitude {
                let got = actual.altitude.ok_or(
                    "Verification failed: altitude was written but is not present",
                )?;
                if (got - expected).abs() > 1.0 {
                    return Err(format!(
                        "Verification failed: wrote altitude {expected} but read back {got}"
                    ));
                }
            }
        }
        None => {}
    }

    Ok(())
}

/// Tag names that identify a person, a place, a device or a moment.
///
/// Checked by suffix, so the group prefix does not matter. This is what a
/// "remove everything" is actually promising to get rid of.
const IDENTIFYING_TAGS: &[&str] = &[
    ":Artist",
    ":Copyright",
    ":Make",
    ":Model",
    ":LensModel",
    ":SerialNumber",
    ":Software",
    ":OwnerName",
    ":CameraSerialNumber",
    ":ImageDescription",
    ":UserComment",
    ":DateTimeOriginal",
    ":CreateDate",
];

/// Whether a raw tag read back as what was asked for.
///
/// Looser than the exact string equality the curated fields use, and it has to
/// be. EXIF stores many numbers as rationals, so `0.008` written to
/// `ExposureTime` comes back as the closest representable value rather than
/// the same digits, and a date can gain a normalised separator. Comparing
/// strings there would fail a *correct* write and roll the whole file back —
/// the user would see "verification failed" for a change that actually worked.
///
/// So: when both sides parse as numbers, compare as numbers with a relative
/// tolerance that is far tighter than any meaningful metadata difference.
/// Otherwise compare exactly. What is not loosened is the consequence — a
/// genuine mismatch still refuses the write, because a tag that silently did
/// not take is the failure this whole step exists to catch.
fn values_agree(expected: &[String], got: &[String]) -> bool {
    if expected.len() != got.len() {
        return false;
    }
    expected.iter().zip(got).all(|(want, have)| {
        if want == have {
            return true;
        }
        match (want.trim().parse::<f64>(), have.trim().parse::<f64>()) {
            (Ok(a), Ok(b)) => {
                let scale = a.abs().max(b.abs()).max(1.0);
                (a - b).abs() <= scale * 1e-6
            }
            _ => false,
        }
    })
}

fn is_blank(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null => true,
        serde_json::Value::String(s) => s.is_empty(),
        serde_json::Value::Array(a) => a.is_empty(),
        _ => false,
    }
}

/// Normalises a read-back value to the same shape `normalise` produces, so the
/// two can be compared without caring whether ExifTool returned a bare string
/// or a one-element array.
fn as_strings(value: Option<&serde_json::Value>) -> Vec<String> {
    match value {
        None | Some(serde_json::Value::Null) => Vec::new(),
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .map(|v| match v {
                serde_json::Value::String(s) => s.clone(),
                other => other.to_string(),
            })
            .collect(),
        Some(serde_json::Value::String(s)) => vec![s.clone()],
        Some(serde_json::Value::Number(n)) => vec![n.to_string()],
        Some(other) => vec![other.to_string()],
    }
}

/// fsyncs the directory holding `path`, so a crash cannot undo the rename.
///
/// POSIX only. Windows has no directory handle to sync and does not need one;
/// NTFS journals the metadata operation itself.
fn sync_parent_dir(path: &Path) {
    #[cfg(unix)]
    {
        if let Some(parent) = path.parent() {
            if let Ok(dir) = std::fs::File::open(parent) {
                let _ = dir.sync_all();
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

/// Removes temp files left behind by a crash mid-write.
///
/// Called when a folder is opened. A crash between the copy and the rename
/// leaves a `.revery_exif.tmp` sibling; the original is intact, but the stray
/// file would otherwise accumulate in the user's photo folder forever.
pub fn sweep_stale_temps(root: &Path) -> usize {
    // A staged temp belonging to a *running* write looks exactly like one left
    // by a crash. The lock is what tells them apart: no write can be in flight
    // while this holds it.
    let _mutations = lock_mutations();
    let Ok(dir) = std::fs::read_dir(root) else {
        return 0;
    };
    let mut removed = 0;
    for entry in dir.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') && name.ends_with(".revery_exif.tmp") {
            if std::fs::remove_file(entry.path()).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

/* ══════════════════════════════════════════════════════════════════════════
   BATCHES
══════════════════════════════════════════════════════════════════════════ */

/// One file's fate within a batch.
#[derive(Debug, Clone, Serialize)]
pub struct FileResult {
    pub path: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BatchOutcome {
    pub results: Vec<FileResult>,
    pub succeeded: usize,
    pub failed: usize,
    /// Why the batch cannot be undone, when it cannot.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub undo_unavailable: Option<String>,
}

/// Applies one edit across many files.
///
/// Two properties matter more than throughput:
///
/// 1. **Every file is checked before any file is written.** A 200-photo batch
///    that is going to fail on a read-only file should fail before it has
///    modified 136 others, leaving the user with a half-applied change and no
///    clear idea where it stopped.
/// 2. **Per-file results, never an aggregate boolean.** If three files in
///    fifty fail, the caller must be able to say which three. Reporting the
///    batch as "failed" would hide the 47 that changed; reporting it as
///    "succeeded" would hide the 3 that did not.
pub fn apply_batch(
    session: &ExifToolSession,
    root: &Path,
    paths: &[String],
    edit: &PhotoEdit,
) -> Result<BatchOutcome, String> {
    let per_file: Vec<(String, PhotoEdit)> =
        paths.iter().map(|p| (p.clone(), edit.clone())).collect();
    apply_per_file(session, root, &per_file)
}

/// Applies a *different* edit to each file, sharing all the batch guarantees.
///
/// Geotagging needs this: every photo gets its own position. Routing it through
/// the same function as an ordinary batch means it inherits the pre-flight, the
/// verification, the atomic rename and the undo snapshot rather than becoming a
/// second write mechanism with its own failure modes.
pub fn apply_per_file(
    session: &ExifToolSession,
    root: &Path,
    edits: &[(String, PhotoEdit)],
) -> Result<BatchOutcome, String> {
    if edits.is_empty() {
        return Err("No photos were selected.".into());
    }
    // Held across both passes, so the pre-flight's answer is still true when
    // the writes run and no other batch can clear the undo store in between.
    let _mutations = lock_mutations();

    // Pass one: resolve, validate and pre-flight *everything* before writing
    // anything. Building each edit's arguments here also means an impossible
    // value fails before any file is opened.
    let mut planned = Vec::with_capacity(edits.len());
    for (path, edit) in edits {
        let args = edit.write_args()?;
        if args.is_empty() {
            continue; // nothing to do for this file
        }
        let resolved = library::resolve_within(root, path)?;
        preflight(&resolved).map_err(|e| format!("{e}. Nothing has been changed."))?;
        planned.push((resolved, args, edit));
    }
    if planned.is_empty() {
        return Err("There are no changes to apply.".into());
    }

    // Pass two: write, snapshotting each file just before it is replaced.
    let mut undo_batch = crate::undo::UndoBatch::begin(root).ok();
    let mut results = Vec::with_capacity(planned.len());
    for (target, args, edit) in &planned {
        if let Some(batch) = undo_batch.as_mut() {
            batch.snapshot(target);
        }
        let temp = temp_path_for(target);
        let outcome = write_through_temp(session, target, &temp, args, edit);
        if outcome.is_err() {
            let _ = std::fs::remove_file(&temp);
        }
        results.push(match outcome {
            Ok(done) => FileResult {
                path: done.path,
                ok: true,
                error: None,
                warnings: done.warnings,
            },
            Err(error) => FileResult {
                path: target.to_string_lossy().into_owned(),
                ok: false,
                error: Some(error),
                warnings: Vec::new(),
            },
        });
    }

    let succeeded = results.iter().filter(|r| r.ok).count();
    let failed = results.len() - succeeded;
    let undo_unavailable = match undo_batch {
        Some(batch) => batch.finish(),
        None => Some("The undo store could not be created.".into()),
    };

    Ok(BatchOutcome {
        results,
        succeeded,
        failed,
        undo_unavailable,
    })
}

/// Writes `content` to `path` atomically. Used for the undo journal.
pub fn atomic_write(path: &Path, content: &[u8]) -> Result<(), String> {
    let temp = temp_path_for(path);
    {
        let mut file = std::fs::File::create(&temp)
            .map_err(|e| format!("Cannot create {}: {e}", temp.display()))?;
        file.write_all(content)
            .and_then(|_| file.sync_all())
            .map_err(|e| {
                let _ = std::fs::remove_file(&temp);
                format!("Write failed: {e}")
            })?;
    }
    std::fs::rename(&temp, path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("Rename failed: {e}")
    })?;
    sync_parent_dir(path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(value: serde_json::Value) -> FieldEdit {
        FieldEdit::Set { value }
    }

    fn edit_with(key: &str, edit: FieldEdit) -> PhotoEdit {
        let mut e = PhotoEdit::default();
        e.fields.insert(key.to_string(), edit);
        e
    }

    #[test]
    fn a_value_is_written_to_every_tag_for_the_field() {
        let args = edit_with("title", set(serde_json::json!("Fjord")))
            .write_args()
            .unwrap();
        // Both standards, not just XMP — software reads whichever it prefers.
        assert!(args.contains(&"-XMP:Title=Fjord".to_string()));
        assert!(args.contains(&"-IPTC:ObjectName=Fjord".to_string()));
    }

    #[test]
    fn setting_a_field_clears_it_first() {
        let args = edit_with("keywords", set(serde_json::json!(["sea", "north"])))
            .write_args()
            .unwrap();
        let subject: Vec<_> = args.iter().filter(|a| a.starts_with("-XMP:Subject")).collect();
        // Clear, then add each. Without the leading clear ExifTool appends,
        // so editing keywords would accumulate the old ones forever.
        assert_eq!(
            subject,
            vec!["-XMP:Subject=", "-XMP:Subject=sea", "-XMP:Subject=north"]
        );
    }

    #[test]
    fn clearing_a_field_deletes_every_tag_it_writes() {
        let args = edit_with("copyright", FieldEdit::Clear).write_args().unwrap();
        assert!(args.contains(&"-XMP:Rights=".to_string()));
        assert!(args.contains(&"-IPTC:CopyrightNotice=".to_string()));
        assert!(args.contains(&"-EXIF:Copyright=".to_string()));
        // Nothing may carry a value.
        assert!(args.iter().all(|a| a.ends_with('=')));
    }

    #[test]
    fn an_absent_field_produces_no_arguments() {
        // The whole three-state model: absent means "leave alone", which must
        // not be confused with Clear.
        let empty = PhotoEdit::default();
        assert!(empty.write_args().unwrap().is_empty());
        assert!(empty.is_empty());
    }

    #[test]
    fn clearing_gps_covers_every_namespace() {
        let mut edit = PhotoEdit::default();
        edit.gps = Some(GpsEdit::Clear);
        let args = edit.write_args().unwrap();
        // `-gps:all=` would leave XMP GPS in the file, so a photo "stripped"
        // before publishing would still carry its coordinates. Verified
        // against the binary in tests/write_path.rs.
        assert_eq!(args, vec!["-GPS*=".to_string()]);
        assert!(!args.iter().any(|a| a == "-gps:all="));
    }

    #[test]
    fn refuses_an_out_of_range_position() {
        let mut edit = PhotoEdit::default();
        edit.gps = Some(GpsEdit::Set {
            position: GpsPosition {
                latitude: 91.0,
                longitude: 0.0,
                altitude: None,
            },
        });
        let err = edit.write_args().unwrap_err();
        assert!(err.contains("out-of-range"), "unexpected: {err}");
    }

    #[test]
    fn rejects_a_list_for_a_scalar_field() {
        let err = edit_with("title", set(serde_json::json!(["a", "b"])))
            .write_args()
            .unwrap_err();
        assert!(err.contains("does not take a list"), "unexpected: {err}");
    }

    #[test]
    fn rejects_an_unknown_field() {
        let err = edit_with("nonsense", set(serde_json::json!("x")))
            .write_args()
            .unwrap_err();
        assert!(err.contains("Unknown field"), "unexpected: {err}");
    }

    /* ── Arbitrary tags ──────────────────────────────────────────────────── */

    fn tag_edit(tag: &str, edit: TagEdit) -> PhotoEdit {
        let mut e = PhotoEdit::default();
        e.tags.insert(tag.to_string(), edit);
        e
    }

    /// The single most important assertion in the raw-tag feature.
    ///
    /// Reads pass `-n`, so the inspector shows machine values. Writing one back
    /// without `#` runs it through the inverse print conversion and stores
    /// something else — silently, with ExifTool reporting success.
    #[test]
    fn a_raw_tag_is_always_written_with_the_no_print_conversion_suffix() {
        let args = tag_edit("XMP:Label", TagEdit::Set { value: serde_json::json!("Red") })
            .write_args()
            .unwrap();
        assert_eq!(args, vec!["-XMP:Label#=", "-XMP:Label#=Red"]);
        // The bare form is what would silently corrupt the value.
        assert!(
            !args.iter().any(|a| a == "-XMP:Label=Red"),
            "wrote without the # suffix: {args:?}"
        );
    }

    #[test]
    fn clearing_a_raw_tag_uses_the_plain_delete_form() {
        // No value to convert, so `#` would be meaningless here.
        let args = tag_edit("EXIF:UserComment", TagEdit::Clear).write_args().unwrap();
        assert_eq!(args, vec!["-EXIF:UserComment="]);
    }

    #[test]
    fn a_multi_valued_raw_tag_clears_before_it_adds() {
        let args = tag_edit(
            "XMP:Subject",
            TagEdit::Set { value: serde_json::json!(["sea", "north"]) },
        )
        .write_args()
        .unwrap();
        // Without the leading clear ExifTool appends, so editing would keep
        // accumulating the old values.
        assert_eq!(
            args,
            vec!["-XMP:Subject#=", "-XMP:Subject#=sea", "-XMP:Subject#=north"]
        );
    }

    #[test]
    fn render_critical_and_derived_tags_are_locked() {
        // The carve-out the feature was asked for.
        assert!(locked_reason("EXIF:Orientation").is_some());
        assert!(locked_reason("EXIF:ColorSpace").is_some());
        assert!(locked_reason("EXIF:BitsPerSample").is_some());
        assert!(locked_reason("EXIF:ImageWidth").is_some());
        assert!(locked_reason("ICC_Profile:ProfileDescription").is_some());
        assert!(locked_reason("JFIF:JFIFVersion").is_some());
        assert!(locked_reason("MakerNotes:LensType").is_some());
        // Pointers into the file.
        assert!(locked_reason("EXIF:StripOffsets").is_some());
        assert!(locked_reason("EXIF:StripByteCounts").is_some());
        assert!(locked_reason("EXIF:ThumbnailOffset").is_some());
        assert!(locked_reason("EXIF:PreviewImageLength").is_some());
        // Not real writable metadata.
        assert!(locked_reason("Composite:GPSLatitude").is_some());
        assert!(locked_reason("File:FileType").is_some());
        assert!(locked_reason("System:FileName").is_some());
        assert!(locked_reason("ExifTool:ExifToolVersion").is_some());
        assert!(locked_reason("SourceFile").is_some());
    }

    #[test]
    fn ordinary_metadata_is_not_locked() {
        // The whole point is that everything else stays editable.
        for tag in [
            "EXIF:UserComment",
            "EXIF:Artist",
            "EXIF:Software",
            "XMP:Label",
            "IPTC:City",
            "EXIF:DateTimeOriginal",
        ] {
            assert!(locked_reason(tag).is_none(), "{tag} should be editable");
        }
        // `Length` cannot be a suffix rule — these are ordinary photographic
        // values that happen to end in it.
        assert!(locked_reason("EXIF:FocalLength").is_none());
        assert!(locked_reason("EXIF:FocalLengthIn35mmFormat").is_none());
    }

    #[test]
    fn a_locked_tag_is_refused_rather_than_written() {
        let err = tag_edit("EXIF:Orientation", TagEdit::Clear)
            .write_args()
            .unwrap_err();
        // The reason travels with the refusal, so the UI can explain itself.
        assert!(err.contains("right way up"), "unexpected: {err}");
    }

    #[test]
    fn a_tag_name_can_never_become_an_exiftool_option() {
        // The name is interpolated into `-{tag}=`, so anything that escapes
        // that shape stops being a tag and starts being a command. `-all=` and
        // `-GPS*=` are real arguments this app issues deliberately elsewhere.
        for bad in [
            "-delete_original!",
            "EXIF:Artist=x",
            "GPS*",
            "all",
            "EXIF:Artist -all",
            "",
        ] {
            assert!(
                tag_edit(bad, TagEdit::Clear).write_args().is_err(),
                "{bad:?} should have been refused"
            );
        }
    }

    #[test]
    fn a_tag_must_name_its_group() {
        // A bare name leaves ExifTool to pick a namespace, and the tag the user
        // then sees may not be the one they thought they were editing.
        let err = tag_edit("Artist", TagEdit::Clear).write_args().unwrap_err();
        assert!(err.contains("which group"), "unexpected: {err}");
    }

    #[test]
    fn a_curated_field_and_a_raw_tag_cannot_fight_over_one_tag() {
        let mut edit = edit_with("title", set(serde_json::json!("From the field")));
        edit.tags.insert(
            "XMP:Title".to_string(),
            TagEdit::Set { value: serde_json::json!("From the tag") },
        );
        // Both write XMP:Title. Applying both would leave whichever ExifTool
        // saw last — indistinguishable from the app ignoring an edit.
        let err = edit.write_args().unwrap_err();
        assert!(err.contains("XMP:Title"), "unexpected: {err}");
    }

    #[test]
    fn binary_values_are_not_editable_as_text() {
        // The inspector shows these as a summary, not a value.
        let err = tag_edit(
            "EXIF:ThumbnailImage",
            TagEdit::Set { value: serde_json::json!("base64:AAAA") },
        )
        .write_args()
        .unwrap_err();
        assert!(err.contains("binary"), "unexpected: {err}");
    }

    #[test]
    fn a_tags_only_edit_is_not_empty() {
        // is_empty() gates the whole write; missing `tags` here would make a
        // raw-tag edit silently do nothing.
        assert!(!tag_edit("XMP:Label", TagEdit::Clear).is_empty());
    }

    #[test]
    fn verification_tolerates_a_rational_round_trip_but_not_a_wrong_value() {
        // EXIF stores many numbers as rationals, so the value read back is the
        // closest representable one rather than the same digits. Comparing
        // strings would fail a correct write and roll the file back.
        assert!(values_agree(&["0.008".into()], &["0.00800000037997961".into()]));
        assert!(values_agree(&["59.9139".into()], &["59.91390000001".into()]));
        // A genuine mismatch must still be caught — that is what the step is for.
        assert!(!values_agree(&["0.008".into()], &["0.004".into()]));
        assert!(!values_agree(&["Red".into()], &["Blue".into()]));
        assert!(!values_agree(&["1".into()], &["1".into(), "2".into()]));
        // Non-numeric values keep exact comparison.
        assert!(values_agree(&["Red".into()], &["Red".into()]));
    }

    #[test]
    fn the_strip_path_and_the_lock_policy_share_one_definition() {
        // `-all=` then re-add. If STRIP_PRESERVES and the render-critical list
        // ever drift, "everything the photo needs to display" would mean two
        // different things in the same file.
        let mut edit = PhotoEdit::default();
        edit.strip = Some(StripEdit::Everything);
        let args = edit.write_args().unwrap();
        for preserved in STRIP_PRESERVES {
            assert!(
                args.contains(&(*preserved).to_string()),
                "{preserved} is not put back after -all="
            );
        }
        assert!(args.contains(&"-Orientation".to_string()));
        assert!(args.contains(&"-icc_profile".to_string()));
        // And every one of them is a tag the All tab refuses to edit.
        assert!(locked_reason("EXIF:Orientation").is_some());
        assert!(locked_reason("ICC_Profile:ProfileDescription").is_some());
    }

    #[test]
    fn temp_names_are_hidden_siblings_the_scanner_ignores() {
        let target = Path::new("/photos/DSC_0001.jpg");
        let temp = temp_path_for(target);
        // Same directory, or the rename could cross a filesystem and stop
        // being atomic.
        assert_eq!(temp.parent(), target.parent());
        let name = temp.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with('.'), "should be hidden: {name}");
        assert!(name.ends_with(".revery_exif.tmp"), "{name}");
        // scan_folder only lists known image extensions, so a temp mid-write
        // can never appear in the grid.
        assert!(!library::is_supported(&temp));
    }

    /// Pre-flight must accept an ordinary photo folder.
    ///
    /// Trivially true on Unix. On Windows it is the whole point: the shell sets
    /// `FILE_ATTRIBUTE_READONLY` on any folder carrying a `desktop.ini`, which
    /// includes Pictures, Documents and Desktop, and reading that bit as
    /// "unwritable" made `apply_per_file` abort every batch before touching a
    /// file. The attribute is set explicitly here so the test reproduces that
    /// folder rather than hoping the temp directory happens to have it.
    #[test]
    fn preflight_accepts_a_folder_windows_marks_read_only() {
        let root = std::env::temp_dir().join("revery-exif-preflight-test");
        std::fs::create_dir_all(&root).unwrap();
        let photo = root.join("a.jpg");
        std::fs::write(&photo, b"x").unwrap();

        #[cfg(windows)]
        {
            let mut perms = std::fs::metadata(&root).unwrap().permissions();
            perms.set_readonly(true);
            std::fs::set_permissions(&root, perms).unwrap();
            assert!(
                std::fs::metadata(&root).unwrap().permissions().readonly(),
                "the fixture did not take the attribute"
            );
        }

        preflight(&photo).expect("an ordinary photo folder must be writable");

        // The probe must not survive — a stray file in the user's photo folder
        // for every file in every batch would be its own bug.
        let strays: Vec<_> = std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".revery_exif.tmp"))
            .collect();
        assert!(strays.is_empty(), "pre-flight left {strays:?} behind");

        #[cfg(windows)]
        {
            let mut perms = std::fs::metadata(&root).unwrap().permissions();
            perms.set_readonly(false);
            std::fs::set_permissions(&root, perms).ok();
        }
        std::fs::remove_dir_all(&root).ok();
    }

    /// A genuinely unwritable *file* must still be refused — the fix loosened
    /// the check on the directory, and only on the directory.
    #[test]
    fn preflight_still_refuses_a_read_only_file() {
        let root = std::env::temp_dir().join("revery-exif-preflight-ro-file-test");
        std::fs::create_dir_all(&root).unwrap();
        let photo = root.join("a.jpg");
        std::fs::write(&photo, b"x").unwrap();
        let mut perms = std::fs::metadata(&photo).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&photo, perms).unwrap();

        let err = preflight(&photo).unwrap_err();
        assert!(err.contains("read-only"), "unexpected: {err}");

        let mut perms = std::fs::metadata(&photo).unwrap().permissions();
        perms.set_readonly(false);
        std::fs::set_permissions(&photo, perms).ok();
        std::fs::remove_dir_all(&root).ok();
    }

    /// The staged file must be flushable.
    ///
    /// Trivially true on Unix, where `fsync` accepts a read-only descriptor.
    /// On Windows `sync_all` is `FlushFileBuffers`, which demands a handle with
    /// `GENERIC_WRITE` and returns `Access is denied. (os error 5)` without
    /// one — so the previous `File::open` here failed on every single file, at
    /// the last step before the rename. Like the pre-flight attribute test,
    /// this can only fire on the platform it protects; it is here so the reason
    /// for the write-mode open is not quietly optimised away.
    #[test]
    fn the_staged_file_can_be_flushed_before_the_rename() {
        let root = std::env::temp_dir().join("revery-exif-flush-test");
        std::fs::create_dir_all(&root).unwrap();
        let staged = root.join("staged.jpg");
        std::fs::write(&staged, b"staged bytes").unwrap();

        flush_to_disk(&staged).expect("the staged file must be flushable");

        // Opening for writing must not have truncated or otherwise disturbed
        // what ExifTool just wrote.
        assert_eq!(std::fs::read(&staged).unwrap(), b"staged bytes");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn temp_names_do_not_collide() {
        let target = Path::new("/photos/a.jpg");
        let a = temp_path_for(target);
        std::thread::sleep(std::time::Duration::from_nanos(10));
        let b = temp_path_for(target);
        assert_ne!(a, b);
    }

    #[test]
    fn read_back_shapes_compare_equal_regardless_of_arity() {
        // ExifTool returns a bare string for one value and an array for
        // several; both must compare cleanly against what was requested.
        assert_eq!(as_strings(Some(&serde_json::json!("solo"))), vec!["solo"]);
        assert_eq!(
            as_strings(Some(&serde_json::json!(["a", "b"]))),
            vec!["a", "b"]
        );
        assert_eq!(as_strings(Some(&serde_json::json!(4))), vec!["4"]);
        assert!(as_strings(None).is_empty());
    }

    #[test]
    fn field_specs_match_the_frontend() {
        // www/js/state.js lists the same tags in read priority order. These
        // are pinned so a change on either side has to be deliberate rather
        // than silently leaving the two reading and writing different tags.
        let by_key = |k: &str| FIELD_SPECS.iter().find(|s| s.key == k).unwrap();
        assert_eq!(by_key("title").write_tags, &["XMP:Title", "IPTC:ObjectName"]);
        assert_eq!(
            by_key("creator").write_tags,
            &["XMP:Creator", "IPTC:By-line", "EXIF:Artist"]
        );
        assert_eq!(
            by_key("keywords").write_tags,
            &["XMP:Subject", "IPTC:Keywords"]
        );
        // Every spec verifies via its own first tag.
        for spec in FIELD_SPECS {
            assert_eq!(
                spec.verify_tag, spec.write_tags[0],
                "{} verifies a tag it does not write first",
                spec.key
            );
        }
    }

    #[test]
    fn json_round_trips_the_three_states() {
        let json = serde_json::json!({
            "title": { "op": "set", "value": "Fjord" },
            "copyright": { "op": "clear" },
            "gps": { "op": "set", "position": { "latitude": 59.9, "longitude": 10.7 } }
        });
        let edit: PhotoEdit = serde_json::from_value(json).unwrap();
        assert_eq!(edit.fields.len(), 2);
        assert!(matches!(edit.fields["copyright"], FieldEdit::Clear));
        assert!(matches!(edit.gps, Some(GpsEdit::Set { .. })));
        // "description" was never mentioned, so it must not appear at all.
        assert!(!edit.fields.contains_key("description"));
    }
}
