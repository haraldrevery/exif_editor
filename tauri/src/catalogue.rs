//! The list of tags a photo can be *given*, as opposed to the ones it has.
//!
//! Editing an existing tag needs no catalogue — the inspector already knows its
//! name. Adding one does, and the honest source for that list is the ExifTool
//! actually bundled with this build rather than a table generated at some point
//! in the past. A shipped list drifts silently: the app offers a tag the engine
//! will not write, or hides one it would.
//!
//! So the binary is asked. `-listx` emits an XML tag database carrying names,
//! groups, types and descriptions.
//!
//! # Why three calls
//!
//! Group arguments do not union — `-listx -EXIF:all -XMP:all` returns EXIF
//! only, silently. Each group is therefore fetched separately.
//!
//! # Why the descriptions arrive in twelve languages
//!
//! `-lang en` would trim them, but it cannot be combined with a group filter:
//! it overrides the filter and dumps the entire 12 MB database instead. Asking
//! per group and discarding the non-English `<desc>` elements here costs less.
//!
//! # Cost
//!
//! Roughly three seconds and two megabytes of XML for the three groups, so this
//! is called once and cached, on first use rather than at launch.

use serde::Serialize;

use crate::exiftool::ExifToolSession;

/// The groups worth offering. Everything else is either not writable at all,
/// not metadata about the photograph, or a container ExifTool will not let you
/// build a tag inside — see `write::locked_reason`, which independently
/// refuses anything that slips through.
const GROUPS: &[&str] = &["EXIF", "XMP", "IPTC"];

/// One tag someone could add to a photo.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TagInfo {
    /// Full `Group:Name`, exactly the key the write path takes.
    pub tag: String,
    pub group: String,
    pub name: String,
    /// ExifTool's storage type — `string`, `int16u`, `rational64s`. Shown so
    /// someone can tell a number from a date before typing into the box.
    #[serde(rename = "type")]
    pub kind: String,
    /// The English description, when the database carries one.
    pub description: String,
}

/// Every tag the bundled ExifTool will write, in the groups this app edits.
///
/// Sorted and de-duplicated: the same name appears under several tables (a tag
/// defined for more than one IFD, say), and offering it twice would look like a
/// bug in the picker.
pub fn writable_tags(session: &ExifToolSession) -> Result<Vec<TagInfo>, String> {
    let mut found: Vec<TagInfo> = Vec::new();

    for group in GROUPS {
        let response = session.execute(&[
            "-listx".to_string(),
            format!("-{group}:all"),
        ])?;
        if response.stdout.trim().is_empty() {
            return Err(format!(
                "ExifTool listed no {group} tags{}",
                if response.has_error() {
                    format!(": {}", response.error_text())
                } else {
                    String::new()
                }
            ));
        }
        parse_into(&response.stdout, &mut found)?;
    }

    found.sort_by(|a, b| a.tag.cmp(&b.tag));
    found.dedup_by(|a, b| a.tag == b.tag);
    Ok(found)
}

/// Pulls the writable tags out of one `-listx` document.
///
/// Group attributes live on the `<table>` and are inherited by its `<tag>`
/// children unless the child overrides them, so the walk has to carry them
/// down — reading `g0` off the tag alone drops most of the database on the
/// floor, and reading it off the table alone mis-files the rest.
fn parse_into(xml: &str, out: &mut Vec<TagInfo>) -> Result<(), String> {
    let doc = roxmltree::Document::parse(xml)
        .map_err(|e| format!("ExifTool's tag list could not be parsed: {e}"))?;

    for table in doc.descendants().filter(|n| n.has_tag_name("table")) {
        let table_group = table.attribute("g0").unwrap_or_default();

        for tag in table.children().filter(|n| n.has_tag_name("tag")) {
            if tag.attribute("writable") != Some("true") {
                continue;
            }
            let Some(name) = tag.attribute("name") else { continue };
            let group = tag.attribute("g0").unwrap_or(table_group);
            if !GROUPS.contains(&group) {
                continue;
            }

            let full = format!("{group}:{name}");
            // The write path is the authority on what may be edited; the picker
            // must not offer something it will then refuse. Checked here rather
            // than trusted to the UI, so both routes agree by construction.
            if crate::write::locked_reason(&full).is_some() {
                continue;
            }

            out.push(TagInfo {
                tag: full,
                group: group.to_string(),
                name: name.to_string(),
                kind: tag.attribute("type").unwrap_or("?").to_string(),
                description: english_description(tag).unwrap_or_default(),
            });
        }
    }
    Ok(())
}

fn english_description(tag: roxmltree::Node) -> Option<String> {
    tag.children()
        .filter(|n| n.has_tag_name("desc"))
        .find(|n| n.attribute("lang") == Some("en"))
        .and_then(|n| n.text())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"<?xml version='1.0' encoding='UTF-8'?>
<taginfo>
<table name='IPTC::ApplicationRecord' g0='IPTC' g1='IPTC' g2='Other'>
 <desc lang='en'>IPTC ApplicationRecord</desc>
 <tag id='90' name='City' type='string' writable='true'>
  <desc lang='en'>City</desc>
  <desc lang='de'>Stadt</desc>
 </tag>
 <tag id='0' name='ReadOnlyThing' type='int16u' writable='false'>
  <desc lang='en'>Read Only Thing</desc>
 </tag>
</table>
<table name='Exif::Main' g0='EXIF' g1='IFD0' g2='Image'>
 <tag id='315' name='Artist' type='string' writable='true'>
  <desc lang='en'>Artist</desc>
 </tag>
 <tag id='274' name='Orientation' type='int16u' writable='true'>
  <desc lang='en'>Orientation</desc>
 </tag>
 <tag id='273' name='StripOffsets' type='int32u' writable='true'/>
 <tag id='1' name='Overridden' type='string' writable='true' g0='XMP'/>
</table>
<table name='PNG::Main' g0='PNG' g1='PNG' g2='Image'>
 <tag id='x' name='Gamma' type='string' writable='true'/>
</table>
</taginfo>"#;

    fn parsed() -> Vec<TagInfo> {
        let mut out = Vec::new();
        parse_into(SAMPLE, &mut out).unwrap();
        out
    }

    #[test]
    fn reads_name_group_type_and_english_description() {
        let city = parsed().into_iter().find(|t| t.name == "City").unwrap();
        assert_eq!(city.tag, "IPTC:City");
        assert_eq!(city.group, "IPTC");
        assert_eq!(city.kind, "string");
        // The English one, not whichever came first.
        assert_eq!(city.description, "City");
    }

    #[test]
    fn the_group_is_inherited_from_the_table_but_a_tag_may_override_it() {
        let tags = parsed();
        // Inherited: the <tag> carries no g0 of its own.
        assert!(tags.iter().any(|t| t.tag == "EXIF:Artist"));
        // Overridden on the tag itself, inside an EXIF table.
        assert!(tags.iter().any(|t| t.tag == "XMP:Overridden"));
    }

    #[test]
    fn tags_the_write_path_refuses_are_never_offered() {
        let tags = parsed();
        // Offering a tag the backend will reject would turn the picker into a
        // list of things that look editable and are not.
        assert!(!tags.iter().any(|t| t.name == "Orientation"));
        assert!(!tags.iter().any(|t| t.name == "StripOffsets"));
    }

    #[test]
    fn unwritable_tags_and_unsupported_groups_are_skipped() {
        let tags = parsed();
        assert!(!tags.iter().any(|t| t.name == "ReadOnlyThing"));
        // PNG is a real group ExifTool can write, but not one this app edits.
        assert!(!tags.iter().any(|t| t.group == "PNG"));
    }

    #[test]
    fn a_missing_description_is_empty_rather_than_an_error() {
        let tags = parsed();
        let overridden = tags.iter().find(|t| t.name == "Overridden").unwrap();
        assert_eq!(overridden.description, "");
    }

    /// Against the real binary: the shape of the database, not just our parser.
    #[test]
    fn the_bundled_binary_lists_the_tags_people_actually_want() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        // See `exiftool::tests::session` — a skip here is a silent pass, so CI
        // sets REVERY_EXIF_REQUIRE_ENGINE to make a missing engine fatal.
        let exe = match ExifToolSession::locate(root) {
            Ok(exe) => exe,
            Err(why) => {
                assert!(
                    std::env::var_os("REVERY_EXIF_REQUIRE_ENGINE").is_none(),
                    "REVERY_EXIF_REQUIRE_ENGINE is set, so a missing engine is a failure: {why}"
                );
                eprintln!("SKIPPING (no vendored ExifTool): {why}");
                return;
            }
        };
        let tags = writable_tags(&ExifToolSession::new(exe)).expect("catalogue");

        assert!(tags.len() > 500, "only found {} tags", tags.len());
        for wanted in ["EXIF:Artist", "EXIF:UserComment", "XMP:Label", "IPTC:City"] {
            assert!(tags.iter().any(|t| t.tag == wanted), "{wanted} is missing");
        }
        // The policy holds against the real database, not only the fixture.
        assert!(!tags.iter().any(|t| t.name == "Orientation"));
        assert!(tags.iter().all(|t| GROUPS.contains(&t.group.as_str())));
        // Sorted and unique, so the picker can show it as-is.
        let mut sorted = tags.clone();
        sorted.sort_by(|a, b| a.tag.cmp(&b.tag));
        assert_eq!(tags, sorted, "the catalogue should come back sorted");
        let mut seen = std::collections::HashSet::new();
        assert!(tags.iter().all(|t| seen.insert(t.tag.clone())), "duplicate tags");
    }
}
