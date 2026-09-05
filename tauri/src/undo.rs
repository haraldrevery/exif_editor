//! Undo for the last applied batch.
//!
//! A batch edit is the operation most likely to be regretted — one wrong value
//! fanned across fifty files. "Undo" here is a real restore of the original
//! bytes, not a best-effort re-edit: re-writing the previous metadata would be
//! another write that could itself fail, and would not reproduce the original
//! file byte-for-byte.
//!
//! # How the snapshot costs nothing
//!
//! Before a file is replaced, its inode is **hard-linked** into the undo store.
//! The write then renames a new file over the original's name, which unlinks
//! the old directory entry — but the inode survives, still referenced by the
//! link. Undo renames it back.
//!
//! So a fifty-photo batch of 40 MB TIFFs costs fifty directory entries, not
//! 2 GB. Hard links need the same filesystem, which is why the store lives
//! inside the library folder rather than in the OS temp directory (usually a
//! separate tmpfs, where every snapshot would be a full copy).
//!
//! Filesystems without hard links — FAT32 on a memory card, some network
//! mounts — fall back to copying, bounded by [`COPY_BUDGET`]. Past that the
//! batch proceeds without undo and says so, rather than silently filling the
//! card.
//!
//! Only the most recent batch is kept. Undo is one step, which bounds the
//! store and matches what the button offers.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Directory name inside the library folder. Hidden, and swept on open.
pub const STORE_DIR: &str = ".revery_exif_undo";

/// How much copying is acceptable when hard links are unavailable. Past this,
/// the batch runs without undo instead of filling the user's disk.
pub const COPY_BUDGET: u64 = 512 * 1024 * 1024;

const MANIFEST: &str = "manifest.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Entry {
    /// Where the file lives, and where it goes back to.
    original: String,
    /// File name inside the store.
    snapshot: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Manifest {
    entries: Vec<Entry>,
}

/// Accumulates snapshots for one batch, then writes the manifest.
pub struct UndoBatch {
    dir: PathBuf,
    manifest: Manifest,
    copied_bytes: u64,
    /// Set when the budget is exceeded or a snapshot fails. The batch still
    /// runs; it simply cannot be undone, and the caller says so.
    disabled: Option<String>,
    next_id: usize,
}

impl UndoBatch {
    /// Clears any previous batch and starts a new one.
    pub fn begin(library_root: &Path) -> Result<Self, String> {
        let dir = library_root.join(STORE_DIR);
        // Only one batch is ever retained, so the previous one goes now.
        // Doing it here rather than after a successful undo means a crashed
        // session cannot leave two generations behind.
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Cannot create the undo store: {e}"))?;
        Ok(Self {
            dir,
            manifest: Manifest::default(),
            copied_bytes: 0,
            disabled: None,
            next_id: 0,
        })
    }

    /// Preserves the current contents of `path` before it is replaced.
    ///
    /// Never fails the batch: if a snapshot cannot be taken, undo is disabled
    /// for the whole batch and the edit goes ahead. Refusing to edit because
    /// the *undo* could not be prepared would be the wrong trade — the write
    /// itself is already atomic and verified.
    pub fn snapshot(&mut self, path: &Path) {
        if self.disabled.is_some() {
            return;
        }
        let id = self.next_id;
        self.next_id += 1;
        let name = format!(
            "{id:04}-{}",
            path.file_name().unwrap_or_default().to_string_lossy()
        );
        let target = self.dir.join(&name);

        // The cheap path: a second directory entry for the same inode.
        if std::fs::hard_link(path, &target).is_ok() {
            self.record(path, name);
            return;
        }

        // No hard links here. Copy, within budget.
        let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        if self.copied_bytes + size > COPY_BUDGET {
            self.disabled = Some(format!(
                "This batch is larger than the {} MB undo limit on a filesystem \
                 without hard links, so it cannot be undone.",
                COPY_BUDGET / (1024 * 1024)
            ));
            return;
        }
        match std::fs::copy(path, &target) {
            Ok(_) => {
                self.copied_bytes += size;
                self.record(path, name);
            }
            Err(e) => {
                self.disabled = Some(format!("Could not prepare undo: {e}"));
            }
        }
    }

    fn record(&mut self, path: &Path, snapshot: String) {
        self.manifest.entries.push(Entry {
            original: path.to_string_lossy().into_owned(),
            snapshot,
        });
    }

    /// Writes the manifest. Returns the reason undo is unavailable, if any.
    ///
    /// The manifest is written **last**, so it exists only when every snapshot
    /// it names is already on disk. A crash mid-batch leaves loose snapshot
    /// files and no manifest, which `undo_last` treats as nothing to undo —
    /// rather than a manifest promising restores it cannot perform.
    pub fn finish(self) -> Option<String> {
        if let Some(reason) = self.disabled {
            let _ = std::fs::remove_dir_all(&self.dir);
            return Some(reason);
        }
        if self.manifest.entries.is_empty() {
            let _ = std::fs::remove_dir_all(&self.dir);
            return Some("Nothing was changed, so there is nothing to undo.".into());
        }
        let json = match serde_json::to_vec_pretty(&self.manifest) {
            Ok(json) => json,
            Err(e) => return Some(format!("Could not record undo state: {e}")),
        };
        match crate::write::atomic_write(&self.dir.join(MANIFEST), &json) {
            Ok(()) => None,
            Err(e) => Some(format!("Could not record undo state: {e}")),
        }
    }
}

/// What an undo did.
#[derive(Debug, Clone, Serialize)]
pub struct UndoOutcome {
    pub restored: usize,
    pub failed: Vec<String>,
}

/// True when there is a batch waiting to be undone.
pub fn is_available(library_root: &Path) -> bool {
    library_root.join(STORE_DIR).join(MANIFEST).is_file()
}

/// Restores the last batch.
pub fn undo_last(library_root: &Path) -> Result<UndoOutcome, String> {
    let dir = library_root.join(STORE_DIR);
    let manifest_path = dir.join(MANIFEST);
    let raw = std::fs::read(&manifest_path)
        .map_err(|_| "There is no recent change to undo.".to_string())?;
    let manifest: Manifest = serde_json::from_slice(&raw)
        .map_err(|e| format!("The undo record could not be read: {e}"))?;

    let mut restored = 0;
    let mut failed = Vec::new();

    for entry in &manifest.entries {
        let snapshot = dir.join(&entry.snapshot);
        let original = PathBuf::from(&entry.original);
        if !snapshot.is_file() {
            failed.push(format!("{}: the saved copy is missing", entry.original));
            continue;
        }
        // Confine the restore to the library, exactly as the write path is.
        // A tampered manifest must not become a way to write anywhere on disk.
        match resolve_under(library_root, &original) {
            Ok(()) => {}
            Err(e) => {
                failed.push(format!("{}: {e}", entry.original));
                continue;
            }
        }
        // Rename, not copy: atomic, and for the hard-link case it costs
        // nothing and restores the exact original inode.
        match std::fs::rename(&snapshot, &original) {
            Ok(()) => restored += 1,
            Err(_) => match restore_by_copy(&snapshot, &original) {
                Ok(()) => restored += 1,
                Err(e) => failed.push(format!("{}: {e}", entry.original)),
            },
        }
    }

    // Consumed either way: a partially applied undo must not be repeatable,
    // or a second press would "restore" the files that already came back and
    // report success it did not achieve.
    let _ = std::fs::remove_dir_all(&dir);

    Ok(UndoOutcome { restored, failed })
}

/// Checks that `candidate` sits inside `root` without requiring it to exist.
///
/// The write path canonicalises both sides, but a restore target may have been
/// deleted since the batch, so the check is done on the cleaned path instead.
fn resolve_under(root: &Path, candidate: &Path) -> Result<(), String> {
    let root = crate::library::canonical(root)
        .map_err(|e| format!("the library folder is unavailable: {e}"))?;
    let parent = crate::library::canonical(candidate.parent().ok_or("no parent directory")?)
        .map_err(|e| format!("its folder is unavailable: {e}"))?;
    if !parent.starts_with(&root) {
        return Err("it is outside the open folder".into());
    }
    Ok(())
}

/// Cross-device fallback: copy into place through a temp, then rename.
fn restore_by_copy(snapshot: &Path, original: &Path) -> Result<(), String> {
    let bytes = std::fs::read(snapshot).map_err(|e| format!("cannot read the saved copy: {e}"))?;
    crate::write::atomic_write(original, &bytes)
}

/// Removes an undo store left by a previous session.
///
/// Called when a folder is opened. Undo is a within-session promise: after a
/// restart the snapshots are just hidden files consuming directory entries,
/// and on a copy-fallback filesystem, real space.
pub fn sweep(library_root: &Path) -> bool {
    let dir = library_root.join(STORE_DIR);
    dir.exists() && std::fs::remove_dir_all(&dir).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("revery-undo-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_snapshot_survives_the_original_being_replaced() {
        let root = scratch("replace");
        let photo = root.join("a.jpg");
        std::fs::write(&photo, b"original bytes").unwrap();

        let mut batch = UndoBatch::begin(&root).unwrap();
        batch.snapshot(&photo);
        assert!(batch.finish().is_none(), "undo should be available");

        // What the write path does: a brand new file renamed over the name.
        let temp = root.join("a.jpg.tmp");
        std::fs::write(&temp, b"edited bytes").unwrap();
        std::fs::rename(&temp, &photo).unwrap();
        assert_eq!(std::fs::read(&photo).unwrap(), b"edited bytes");

        let outcome = undo_last(&root).unwrap();
        assert_eq!(outcome.restored, 1);
        assert!(outcome.failed.is_empty());
        // Byte-identical, because it is the same inode coming back.
        assert_eq!(std::fs::read(&photo).unwrap(), b"original bytes");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_snapshot_costs_no_extra_space_on_a_normal_filesystem() {
        let root = scratch("cheap");
        let photo = root.join("big.jpg");
        std::fs::write(&photo, vec![7u8; 1024 * 256]).unwrap();

        let mut batch = UndoBatch::begin(&root).unwrap();
        batch.snapshot(&photo);
        // Hard-linked, so nothing was copied. A batch of large files must not
        // duplicate them.
        assert_eq!(batch.copied_bytes, 0, "the snapshot copied bytes");
        batch.finish();

        std::fs::remove_dir_all(&root).ok();
    }

    /// The invariant the whole scheme rests on, stated as a test.
    ///
    /// A hard-link snapshot preserves an *inode*, not a name. It therefore
    /// only protects against a replacement that creates a new inode — which is
    /// what `rename` does and what the write path always uses. A write that
    /// truncates the file in place mutates the very inode the snapshot points
    /// at, and undo silently restores the edited content as if it were the
    /// original.
    ///
    /// This is pinned so that if anyone ever adds an in-place write path, the
    /// consequence for undo is written down next to it rather than discovered
    /// by a user who cannot get their photo back.
    #[test]
    fn an_in_place_write_would_defeat_the_snapshot() {
        let root = scratch("inplace");
        let photo = root.join("a.jpg");
        std::fs::write(&photo, b"original").unwrap();

        let mut batch = UndoBatch::begin(&root).unwrap();
        batch.snapshot(&photo);
        batch.finish();

        let snapshot = root.join(STORE_DIR).join("0000-a.jpg");

        // In place: same inode, so the snapshot sees the change too.
        std::fs::write(&photo, b"edited!!").unwrap();
        assert_eq!(
            std::fs::read(&snapshot).unwrap(),
            b"edited!!",
            "an in-place write is expected to reach through the hard link"
        );

        // By rename: a new inode, so the snapshot still holds the original.
        std::fs::write(&photo, b"original").unwrap();
        replace_by_rename(&photo, b"replaced");
        assert_eq!(
            std::fs::read(&snapshot).unwrap(),
            b"original",
            "a renamed replacement must leave the snapshot untouched"
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn undo_is_a_single_step_and_cannot_be_repeated() {
        let root = scratch("single");
        let photo = root.join("a.jpg");
        std::fs::write(&photo, b"v1").unwrap();

        let mut batch = UndoBatch::begin(&root).unwrap();
        batch.snapshot(&photo);
        batch.finish();
        replace_by_rename(&photo, b"v2");

        assert!(is_available(&root));
        assert_eq!(undo_last(&root).unwrap().restored, 1);
        // A second press must not claim to have restored anything.
        assert!(!is_available(&root));
        assert!(undo_last(&root).is_err());

        std::fs::remove_dir_all(&root).ok();
    }

    /// Replaces a file the way the write path does: a new inode renamed over
    /// the name.
    ///
    /// **Not** `fs::write`, which truncates the existing inode in place. That
    /// distinction is the whole basis of the hard-link snapshot — see
    /// `an_in_place_write_would_defeat_the_snapshot`.
    fn replace_by_rename(path: &Path, content: &[u8]) {
        let temp = path.with_extension("replacing");
        std::fs::write(&temp, content).unwrap();
        std::fs::rename(&temp, path).unwrap();
    }

    #[test]
    fn a_new_batch_discards_the_previous_one() {
        let root = scratch("supersede");
        let photo = root.join("a.jpg");
        std::fs::write(&photo, b"v1").unwrap();

        let mut first = UndoBatch::begin(&root).unwrap();
        first.snapshot(&photo);
        first.finish();
        replace_by_rename(&photo, b"v2");

        let mut second = UndoBatch::begin(&root).unwrap();
        second.snapshot(&photo);
        second.finish();
        replace_by_rename(&photo, b"v3");

        // Undo goes back one step, to v2 — not all the way to v1. Offering a
        // button labelled "undo" that jumps two edits back would be worse than
        // offering none.
        undo_last(&root).unwrap();
        assert_eq!(std::fs::read(&photo).unwrap(), b"v2");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_batch_with_no_snapshots_offers_no_undo() {
        let root = scratch("empty");
        let batch = UndoBatch::begin(&root).unwrap();
        assert!(batch.finish().is_some(), "should report why undo is absent");
        assert!(!is_available(&root));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn loose_snapshots_without_a_manifest_are_not_treated_as_undoable() {
        let root = scratch("crashed");
        let photo = root.join("a.jpg");
        std::fs::write(&photo, b"v1").unwrap();

        // What a crash mid-batch leaves: snapshots taken, manifest never
        // written. The manifest is written last precisely so this state is
        // unambiguous.
        let mut batch = UndoBatch::begin(&root).unwrap();
        batch.snapshot(&photo);
        std::mem::forget(batch); // simulate the process dying before finish()

        assert!(!is_available(&root));
        assert!(undo_last(&root).is_err());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_manifest_pointing_outside_the_library_is_refused() {
        let root = scratch("escape");
        let outside_dir = scratch("escape-target");
        let victim = outside_dir.join("victim.txt");
        std::fs::write(&victim, b"must not be overwritten").unwrap();

        let store = root.join(STORE_DIR);
        std::fs::create_dir_all(&store).unwrap();
        std::fs::write(store.join("0000-x"), b"attacker bytes").unwrap();
        let manifest = serde_json::json!({
            "entries": [{ "original": victim.to_str().unwrap(), "snapshot": "0000-x" }]
        });
        std::fs::write(
            store.join(MANIFEST),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();

        let outcome = undo_last(&root).unwrap();
        assert_eq!(outcome.restored, 0);
        assert_eq!(outcome.failed.len(), 1);
        assert!(outcome.failed[0].contains("outside the open folder"));
        assert_eq!(
            std::fs::read(&victim).unwrap(),
            b"must not be overwritten",
            "a file outside the library was modified"
        );

        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&outside_dir).ok();
    }

    #[test]
    fn sweeping_removes_a_store_from_a_previous_session() {
        let root = scratch("sweep");
        let photo = root.join("a.jpg");
        std::fs::write(&photo, b"v1").unwrap();
        let mut batch = UndoBatch::begin(&root).unwrap();
        batch.snapshot(&photo);
        batch.finish();

        assert!(is_available(&root));
        assert!(sweep(&root));
        assert!(!is_available(&root));
        // Sweeping must not disturb the photos themselves.
        assert_eq!(std::fs::read(&photo).unwrap(), b"v1");
        assert!(!sweep(&root), "sweeping twice should be a no-op");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_missing_snapshot_is_reported_rather_than_silently_skipped() {
        let root = scratch("missing");
        let photo = root.join("a.jpg");
        std::fs::write(&photo, b"v1").unwrap();
        let mut batch = UndoBatch::begin(&root).unwrap();
        batch.snapshot(&photo);
        batch.finish();

        // Something removed the snapshot behind our back.
        std::fs::remove_file(root.join(STORE_DIR).join("0000-a.jpg")).unwrap();
        replace_by_rename(&photo, b"v2");

        let outcome = undo_last(&root).unwrap();
        assert_eq!(outcome.restored, 0);
        assert_eq!(outcome.failed.len(), 1, "the failure must be reported");
        assert_eq!(std::fs::read(&photo).unwrap(), b"v2");

        std::fs::remove_dir_all(&root).ok();
    }
}
