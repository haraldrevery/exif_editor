/**
 * state.js — selection model and multi-file field resolution.
 *
 * Pure logic, no DOM. Loaded as a global in the app and required directly by
 * `test/state.test.js`, so the parts most likely to be got wrong — what a
 * field shows across a mixed selection, what a range-select actually covers —
 * are testable without a running window.
 */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.ExifState = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ── Curated fields ───────────────────────────────────────────────────────
     The ~10 things people actually edit. Each names the tags it reads from, in
     priority order, because the same human concept lives in EXIF, IPTC and XMP
     under different names and the first one present wins.

     Writing (Phase 2) fans a value back out across *all* of a field's tags —
     a title stored only in XMP is invisible in a great deal of software. The
     read order here is the same list, which keeps one definition rather than
     two that can drift.                                                    */
  const FIELDS = [
    {
      key: 'title',
      label: 'Title',
      tags: ['XMP:Title', 'IPTC:ObjectName'],
    },
    {
      key: 'description',
      label: 'Description',
      tags: ['XMP:Description', 'IPTC:Caption-Abstract', 'EXIF:ImageDescription'],
    },
    {
      key: 'keywords',
      label: 'Keywords',
      tags: ['XMP:Subject', 'IPTC:Keywords'],
      list: true,
    },
    {
      key: 'creator',
      label: 'Creator',
      tags: ['XMP:Creator', 'IPTC:By-line', 'EXIF:Artist'],
      // dc:creator is an ordered sequence — a photo can legitimately credit
      // more than one person, and ExifTool returns an array when it does.
      list: true,
    },
    {
      key: 'copyright',
      label: 'Copyright',
      tags: ['XMP:Rights', 'IPTC:CopyrightNotice', 'EXIF:Copyright'],
    },
    {
      key: 'dateTaken',
      label: 'Date taken',
      tags: ['EXIF:DateTimeOriginal', 'EXIF:CreateDate', 'XMP:DateTimeOriginal'],
    },
    {
      key: 'camera',
      label: 'Camera',
      tags: ['EXIF:Model'],
      readOnly: true,
    },
    {
      key: 'lens',
      label: 'Lens',
      tags: ['EXIF:LensModel', 'Composite:LensID', 'XMP:Lens'],
      readOnly: true,
    },
    {
      key: 'rating',
      label: 'Rating',
      tags: ['XMP:Rating'],
    },
  ];

  /** Sentinel for "these files disagree". */
  const MIXED = Symbol('mixed');

  /**
   * Reads one field from one file's tag object.
   * Returns null when no tag in the field carries a value.
   */
  function readField(entry, field) {
    if (!entry) return null;
    for (const tag of field.tags) {
      const value = entry[tag];
      if (value === undefined || value === null || value === '') continue;
      if (field.list) {
        // ExifTool emits a bare string for a single keyword and an array for
        // several. Normalising here means callers never branch on it.
        return Array.isArray(value) ? value.slice() : [value];
      }
      return value;
    }
    return null;
  }

  /** Stable comparison, so ["a","b"] from two files counts as equal. */
  function sameValue(a, b) {
    if (Array.isArray(a) && Array.isArray(b)) {
      return a.length === b.length && a.every((item, i) => item === b[i]);
    }
    return a === b;
  }

  /**
   * Resolves a field across a selection.
   *
   *   { state: 'empty' }            no file in the selection has a value
   *   { state: 'single', value }    every file agrees (including "all empty"
   *                                 vs "all the same value")
   *   { state: 'mixed' }            the files disagree
   *
   * The empty/mixed distinction is the one that matters: a blank box for a
   * mixed selection would make "leave unchanged" and "clear this on all"
   * indistinguishable, which is the classic batch-metadata data-loss bug.
   */
  function resolveField(entries, field) {
    if (!entries.length) return { state: 'empty' };
    let first = readField(entries[0], field);
    for (let i = 1; i < entries.length; i += 1) {
      if (!sameValue(readField(entries[i], field), first)) {
        return { state: 'mixed' };
      }
    }
    if (first === null) return { state: 'empty' };
    return { state: 'single', value: first };
  }

  /* ── Drafts ─────────────────────────────────────────────────────────────
     A draft is what the user has typed but not yet applied, kept per file so
     that clicking another photo does not throw it away.

     **A draft holds raw typed values and nothing else.** No baseline, no
     derived edit. `buildEdit` decides set/clear/no-op by diffing what was
     typed against what the file currently holds; a draft that carried its own
     baseline would keep diffing against a snapshot of the past, so after the
     file changed on disk a real change could be silently downgraded to a
     no-op — a save that reports success and writes nothing. The baseline is
     always recomputed from current metadata when a draft is loaded.        */

  const EMPTY_DRAFT = { pending: {}, gpsPending: undefined, tagPending: {} };

  /**
   * What a selection currently holds, per field — the thing an edit is diffed
   * against.
   *
   * One definition, used by the panel to render and by the apply path to build
   * a per-file edit. Those two must agree about what a file already contains,
   * or the review dialog shows one thing and the write does another.
   */
  function baselineFor(entries) {
    const baseline = {};
    for (const field of FIELDS) {
      baseline[field.key] = resolveField(entries, field);
    }
    baseline.gps = resolvePositions(entries.map((entry) => positionOf(entry)));
    return baseline;
  }

  /** Whether a draft would stage anything at all. */
  function draftIsEmpty(draft) {
    if (!draft) return true;
    if (draft.gpsPending !== undefined) return false;
    return (
      Object.keys(draft.pending || {}).length === 0 &&
      Object.keys(draft.tagPending || {}).length === 0
    );
  }

  /**
   * Resolves one field across a selection's *drafts*, in the same three-state
   * shape `resolveField` uses for stored values.
   *
   * Returns `null` when no draft in the selection touches this field at all —
   * distinct from `{ state: 'empty' }`, which means every draft touches it and
   * they all say "blank". The caller falls back to the stored value in the
   * first case and must not in the second: an untouched field shows what is in
   * the file, whereas a field the user deliberately emptied has to keep
   * showing empty, or their clear is invisible until they apply it.
   */
  function resolveDraftField(drafts, key) {
    const touched = (drafts || []).filter(
      (draft) => draft && draft.pending && key in draft.pending
    );
    if (!touched.length) return null;
    // A selection where only some drafts touch the field is a disagreement:
    // the rest would keep whatever the file already has.
    if (touched.length !== (drafts || []).length) return { state: 'mixed' };

    const first = String(touched[0].pending[key]);
    for (let i = 1; i < touched.length; i += 1) {
      if (String(touched[i].pending[key]) !== first) return { state: 'mixed' };
    }
    if (first.trim() === '') return { state: 'empty' };
    return { state: 'single', value: first };
  }

  /* ── Selection ──────────────────────────────────────────────────────────
     Ordered list + anchor, so shift-click covers what the user sees rather
     than insertion order.                                                  */

  function createSelection() {
    return { paths: [], anchor: null };
  }

  /** Replaces the selection with a single item, and sets the shift anchor. */
  function selectOnly(selection, path) {
    return { paths: [path], anchor: path };
  }

  /** Ctrl/Cmd-click: add or remove one item, moving the anchor to it. */
  function toggle(selection, path) {
    const has = selection.paths.includes(path);
    const paths = has
      ? selection.paths.filter((p) => p !== path)
      : selection.paths.concat(path);
    // Removing the anchor would make the next shift-click jump from a stale
    // point; fall back to whatever is still selected.
    const anchor = has ? paths[paths.length - 1] ?? null : path;
    return { paths, anchor };
  }

  /**
   * Shift-click: everything between the anchor and `path` in display order.
   * With no anchor yet, behaves as a plain click.
   */
  function selectRange(selection, path, ordered) {
    if (!selection.anchor) return selectOnly(selection, path);
    const from = ordered.indexOf(selection.anchor);
    const to = ordered.indexOf(path);
    if (from === -1 || to === -1) return selectOnly(selection, path);
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    // The anchor stays put, so repeated shift-clicks grow and shrink one
    // range instead of leapfrogging.
    return { paths: ordered.slice(lo, hi + 1), anchor: selection.anchor };
  }

  function selectAll(ordered) {
    return { paths: ordered.slice(), anchor: ordered[0] ?? null };
  }

  /**
   * Drops paths that are no longer present — after a refresh, files may have
   * been deleted or renamed outside the app. Keeping them selected would make
   * a later batch edit target files that are gone.
   */
  function pruneSelection(selection, ordered) {
    const present = new Set(ordered);
    const paths = selection.paths.filter((p) => present.has(p));
    const anchor = present.has(selection.anchor) ? selection.anchor : paths[0] ?? null;
    return { paths, anchor };
  }

  /* ── Filtering ────────────────────────────────────────────────────────── */

  function filterEntries(entries, query) {
    const needle = (query || '').trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter((e) => e.name.toLowerCase().includes(needle));
  }

  /* ── Paths ────────────────────────────────────────────────────────────── */

  /**
   * The filename part of a path, whichever separator the platform uses.
   *
   * Two different kinds of path reach the frontend and they do not agree.
   * `PhotoEntry.path` comes from Rust and uses the native separator, so it is
   * backslash-separated on Windows. ExifTool's `SourceFile` is always
   * forward-slash separated, because it rewrites every filename it is given
   * (`CleanFilename`). Splitting on `/` alone therefore works for one and
   * silently returns the entire path for the other — which is what a Windows
   * user saw in place of a filename in every failure message.
   */
  /**
   * A path in a form that can be compared across the Rust/ExifTool boundary.
   *
   * Rust emits the native separator and ExifTool always emits forward slashes,
   * so for the same file on Windows the two strings never match. Anything
   * pairing one with the other has to compare a normalised form.
   *
   * Separators only — case is deliberately left alone. Windows filesystems are
   * usually case-insensitive and Linux ones are not, and folding case here
   * would let two genuinely different files collide on Linux.
   */
  function normalisePath(path) {
    return typeof path === 'string' ? path.replace(/\\/g, '/') : '';
  }

  function basename(path) {
    if (typeof path !== 'string' || !path) return '';
    const parts = path.split(/[\\/]/);
    // Trailing separator: fall back to the last non-empty segment rather than
    // returning ''.
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      if (parts[i]) return parts[i];
    }
    return path;
  }

  /* ── Tag policy ───────────────────────────────────────────────────────────
     A mirror of `locked_reason` in tauri/src/write.rs, used *only* to decide
     whether the All tab draws an edit button and what it says instead.

     The backend is the authority and refuses a locked tag regardless of what
     the UI does — the IPC boundary is not trusted. This copy exists so a
     locked row can be drawn without a round trip per tag. The two lists are
     compared by test/tag_policy.test.js, which reads write.rs, so a change on
     one side without the other fails rather than drifting silently.       */

  const UNWRITABLE_GROUPS = {
    Composite: 'worked out from other tags, so there is nothing to write',
    File: 'describes the file container, not the photo',
    System: 'belongs to the filesystem, not the photo',
    ExifTool: "ExifTool's own notes about reading the file",
  };

  const LOCKED_GROUPS = {
    ICC_Profile: 'part of how the colours are decoded',
    JFIF: 'part of how the file is decoded',
    MakerNotes:
      'a block written by the camera; changing single entries in it corrupts the rest',
  };

  const RENDER_CRITICAL = {
    Orientation: 'kept so the photo displays the right way up',
    ColorSpace: 'describes how to decode the colours',
    WhitePoint: 'describes how to decode the colours',
    PrimaryChromaticities: 'describes how to decode the colours',
    TransferFunction: 'describes how to decode the colours',
    ReferenceBlackWhite: 'describes how to decode the colours',
    YCbCrCoefficients: 'describes how to decode the colours',
    YCbCrPositioning: 'describes how to decode the colours',
    YCbCrSubSampling: 'describes how to decode the colours',
    BitsPerSample: 'describes how to decode the pixels',
    Compression: 'describes how to decode the pixels',
    PhotometricInterpretation: 'describes how to decode the pixels',
    SamplesPerPixel: 'describes how to decode the pixels',
    PlanarConfiguration: 'describes how to decode the pixels',
    RowsPerStrip: 'describes how to decode the pixels',
    ImageWidth: 'describes the size of the picture',
    ImageHeight: 'describes the size of the picture',
    ImageLength: 'describes the size of the picture',
    ExifImageWidth: 'describes the size of the picture',
    ExifImageHeight: 'describes the size of the picture',
    ExifVersion: 'says which version of the format this is',
    FlashpixVersion: 'says which version of the format this is',
    InteropIndex: 'says which version of the format this is',
    InteropVersion: 'says which version of the format this is',
  };

  const POINTER_SUFFIXES = ['Offset', 'Offsets', 'ByteCounts'];

  // Whole names: `Length` cannot be a suffix rule, or FocalLength would lock.
  const POINTER_NAMES = [
    'ThumbnailOffset',
    'ThumbnailLength',
    'PreviewImageStart',
    'PreviewImageLength',
    'JpgFromRawStart',
    'JpgFromRawLength',
    'OtherImageStart',
    'OtherImageLength',
  ];

  /**
   * Why this tag cannot be edited, or null when it can.
   *
   * Phrased to complete the sentence "this tag is …", because the All tab
   * shows it next to the locked row. Someone who wonders why they cannot
   * delete Orientation deserves an answer rather than a greyed-out button.
   */
  function lockedReason(tag) {
    if (typeof tag !== 'string' || !tag) return 'not a tag';
    if (tag === 'SourceFile') {
      return 'the path the file was read from, not metadata in it';
    }
    const idx = tag.indexOf(':');
    const group = idx === -1 ? '' : tag.slice(0, idx);
    const name = idx === -1 ? tag : tag.slice(idx + 1);

    if (UNWRITABLE_GROUPS[group]) return UNWRITABLE_GROUPS[group];
    if (LOCKED_GROUPS[group]) return LOCKED_GROUPS[group];
    if (RENDER_CRITICAL[name]) return RENDER_CRITICAL[name];
    if (POINTER_SUFFIXES.some((s) => name.endsWith(s)) || POINTER_NAMES.includes(name)) {
      return 'a position inside the file rather than a value';
    }
    if (idx === -1) return 'not a tag this app knows how to write';
    return null;
  }

  /**
   * Whether a tag's value is something the All tab can edit as text.
   *
   * The inspector renders binary tags as `(binary, N bytes encoded)`, which is
   * a summary rather than a value — offering to edit it would invite writing
   * that sentence into the file.
   */
  function isEditableValue(value) {
    if (Array.isArray(value)) return value.every(isEditableValue);
    if (typeof value === 'number' || typeof value === 'boolean') return true;
    if (typeof value !== 'string') return false;
    return !value.startsWith('base64:');
  }

  /* ── Metadata helpers ─────────────────────────────────────────────────── */

  /**
   * Signed decimal position from one file's tags.
   *
   * Reads the Composite group, which carries the sign. The raw EXIF values are
   * unsigned magnitudes with the hemisphere in a separate Ref tag — using them
   * directly puts every southern-hemisphere photo in the north.
   */
  function positionOf(entry) {
    if (!entry) return null;
    const lat = entry['Composite:GPSLatitude'];
    const lon = entry['Composite:GPSLongitude'];
    if (typeof lat !== 'number' || typeof lon !== 'number') return null;
    if (Number.isNaN(lat) || Number.isNaN(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    const alt = entry['Composite:GPSAltitude'];
    return { latitude: lat, longitude: lon, altitude: typeof alt === 'number' ? alt : null };
  }

  /** Human-readable position, e.g. `59.913900° N, 10.752200° E`. */
  function formatPosition(position) {
    if (!position) return null;
    const ns = position.latitude >= 0 ? 'N' : 'S';
    const ew = position.longitude >= 0 ? 'E' : 'W';
    return (
      `${Math.abs(position.latitude).toFixed(6)}° ${ns}, ` +
      `${Math.abs(position.longitude).toFixed(6)}° ${ew}`
    );
  }

  /* ── Pending changes ─────────────────────────────────────────────────────
     Edits accumulate in memory and touch nothing until Apply. You often adjust
     a value several times before committing, and writing on every keystroke
     would mean hundreds of file rewrites per session.                       */

  /**
   * Turns what the user typed into the edit the backend will apply.
   *
   * `pending` maps field key -> the raw input string (or an array for list
   * fields). `original` is the resolution each field started from, so a value
   * that was retyped identically produces no change at all.
   *
   * Three outcomes per field, and the third is the important one:
   *   set    — a value to write
   *   clear  — explicitly emptied by the user, which deletes the tag
   *   absent — untouched, and therefore left exactly as it is
   */
  function buildEdit(pending, original, gpsPending, gpsOriginal, tagPending) {
    const edit = {};
    for (const [key, raw] of Object.entries(pending || {})) {
      const field = FIELDS.find((f) => f.key === key);
      if (!field || field.readOnly) continue;

      const before = original ? original[key] : undefined;
      const value = field.list ? parseList(raw) : String(raw);
      const isEmpty = field.list ? value.length === 0 : value.trim() === '';

      if (isEmpty) {
        // Only a *change* to empty is a clear. A field that was already empty
        // and is still empty must not issue a delete for tags that were never
        // there — that would rewrite files for no reason.
        if (before && before.state !== 'empty') edit[key] = { op: 'clear' };
        continue;
      }
      if (before && before.state === 'single' && sameValue(before.value, value)) {
        continue; // retyped identically
      }
      edit[key] = { op: 'set', value };
    }

    if (gpsPending !== undefined) {
      // `gpsOriginal` is a resolution, not a bare position, for the same
      // reason the text fields are: "these photos disagree" and "none of them
      // has a location" must not collapse into one state. If they did,
      // emptying the box on a mixed selection would quietly do nothing —
      // leaving the located photos still carrying their coordinates after the
      // user asked for them gone.
      const before = normaliseGpsBaseline(gpsOriginal);
      if (gpsPending === null) {
        if (before.state !== 'empty') edit.gps = { op: 'clear' };
      } else if (
        before.state !== 'single' ||
        Math.abs(before.value.latitude - gpsPending.latitude) > 1e-9 ||
        Math.abs(before.value.longitude - gpsPending.longitude) > 1e-9
      ) {
        edit.gps = { op: 'set', position: gpsPending };
      }
    }

    // Raw tags from the All tab. Unlike the curated fields these arrive already
    // decided — the inspector stages `{op}` objects rather than input strings,
    // because a tag has no baseline resolution to diff against and no list
    // flag to interpret. Locked tags are dropped rather than sent: the backend
    // would refuse them anyway, and failing the whole batch over a button that
    // should never have been drawn would be a poor trade.
    const tags = {};
    for (const [tag, staged] of Object.entries(tagPending || {})) {
      if (!staged || lockedReason(tag)) continue;
      tags[tag] = staged;
    }
    if (Object.keys(tags).length) edit.tags = tags;

    return edit;
  }

  /**
   * How many separate changes an edit represents.
   *
   * Not `Object.keys(edit).length`: `tags` is one key holding any number of
   * them, so a dozen tag edits would otherwise be announced as "1 change, not
   * yet saved" in the bar that is the user's last look before writing.
   */
  function countChanges(edit) {
    if (!edit) return 0;
    return Object.entries(edit).reduce(
      (total, [key, value]) =>
        total + (key === 'tags' ? Object.keys(value || {}).length : 1),
      0
    );
  }

  /** Accepts a resolution, a bare position, or null/undefined. */
  function normaliseGpsBaseline(value) {
    if (!value) return { state: 'empty' };
    if (typeof value.state === 'string') return value;
    return { state: 'single', value };
  }

  /** Resolves a selection's positions into the same three-state shape. */
  function resolvePositions(positions) {
    if (!positions.length) return { state: 'empty' };
    const first = positions[0];
    const same = positions.every(
      (p) => formatPosition(p) === formatPosition(first)
    );
    if (!same) return { state: 'mixed' };
    if (!first) return { state: 'empty' };
    return { state: 'single', value: first };
  }

  /** Splits a comma-separated input into trimmed, non-empty items. */
  function parseList(raw) {
    if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean);
    return String(raw)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /** Whether an edit would actually write anything. */
  function editIsEmpty(edit) {
    return !edit || Object.keys(edit).length === 0;
  }

  /**
   * A human-readable diff, shown before anything is written.
   *
   * Nothing reaches disk until the user has seen this, which is the whole
   * point of accumulating changes rather than writing as they type.
   */
  function summariseEdit(edit, original, tagBaseline) {
    const rows = [];
    for (const [key, change] of Object.entries(edit || {})) {
      if (key === 'tags') {
        // One row per tag, labelled by its full name. A raw tag has no curated
        // label to fall back on, and the group is the half that tells the user
        // *which* Title they are about to overwrite.
        for (const [tag, staged] of Object.entries(change || {})) {
          const was = tagBaseline ? tagBaseline[tag] : undefined;
          rows.push({
            label: tag,
            from: was === undefined || was === null ? 'not set' : describeTagValue(was),
            to:
              staged.op === 'clear'
                ? 'removed'
                : Array.isArray(staged.value)
                  ? staged.value.join(', ')
                  : String(staged.value),
          });
        }
        continue;
      }
      if (key === 'gps') {
        const before = normaliseGpsBaseline(original && original.gps);
        rows.push({
          label: 'Location',
          from:
            before.state === 'mixed'
              ? '—— mixed ——'
              : before.state === 'single'
                ? formatPosition(before.value)
                : 'not set',
          to: change.op === 'clear' ? 'removed' : formatPosition(change.position),
        });
        continue;
      }
      const field = FIELDS.find((f) => f.key === key);
      const before = original ? original[key] : undefined;
      rows.push({
        label: field ? field.label : key,
        from: before ? describeField(before, field).text : 'not set',
        to:
          change.op === 'clear'
            ? 'removed'
            : Array.isArray(change.value)
              ? change.value.join(', ')
              : String(change.value),
      });
    }
    return rows;
  }

  /* ── Coordinate parsing ──────────────────────────────────────────────────
     Accepts what people actually have in their clipboard. Parsing is where
     silent wrong-hemisphere bugs live, so it is pure and heavily tested.    */

  /**
   * Parses a coordinate pair. Returns `{latitude, longitude}` or null.
   *
   * Handles decimal pairs, degrees/minutes/seconds with hemisphere letters,
   * and Google Maps URLs.
   */
  function parseCoordinates(input) {
    if (typeof input !== 'string') return null;
    const text = input.trim();
    if (!text) return null;

    // Map sites each encode the pair differently, and people paste whatever is
    // in the address bar. Ordered most-specific first: a marker parameter is a
    // deliberate pin, so it beats the view centre in a URL carrying both.
    const N = '(-?\\d+(?:\\.\\d+)?)';
    const urlForms = [
      // geo:59.9139,10.7522 — OSM's "share" and most Android map apps.
      new RegExp(`^geo:${N},${N}`, 'i'),
      // OpenStreetMap share link: ?mlat=&mlon= is the dropped marker.
      new RegExp(`[?&]mlat=${N}[^]*?[?&]mlon=${N}`, 'i'),
      // Google Maps place or view URL: /@lat,lon,zoom
      new RegExp(`@${N},${N}`),
      // Google and Apple query parameters.
      new RegExp(`[?&](?:q|ll|daddr|sll|center)=${N},${N}`, 'i'),
      // Bing separates with a tilde.
      new RegExp(`[?&]cp=${N}~${N}`, 'i'),
      // OpenStreetMap address bar: #map=zoom/lat/lon — note the zoom comes
      // first, so the pair is the second and third numbers.
      new RegExp(`#map=\\d+(?:\\.\\d+)?/${N}/${N}`, 'i'),
    ];
    for (const form of urlForms) {
      const match = text.match(form);
      if (match) return validated(parseFloat(match[1]), parseFloat(match[2]));
    }

    // Degrees/minutes/seconds, e.g. 59°54'50.0"N 10°45'07.9"E
    const dms = [...text.matchAll(
      /(\d+(?:\.\d+)?)\s*°\s*(?:(\d+(?:\.\d+)?)\s*['′]\s*)?(?:(\d+(?:\.\d+)?)\s*["″]\s*)?([NSEW])/gi
    )];
    if (dms.length === 2) {
      const parts = dms.map((m) => {
        const degrees = parseFloat(m[1]);
        const minutes = m[2] ? parseFloat(m[2]) : 0;
        const seconds = m[3] ? parseFloat(m[3]) : 0;
        const hemisphere = m[4].toUpperCase();
        const magnitude = degrees + minutes / 60 + seconds / 3600;
        return { value: hemisphere === 'S' || hemisphere === 'W' ? -magnitude : magnitude,
                 axis: hemisphere === 'N' || hemisphere === 'S' ? 'lat' : 'lon' };
      });
      const lat = parts.find((p) => p.axis === 'lat');
      const lon = parts.find((p) => p.axis === 'lon');
      if (!lat || !lon) return null;
      return validated(lat.value, lon.value);
    }

    // A plain signed pair: "59.9139, 10.7522".
    const plain = text.match(/^(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)$/);
    if (plain) return validated(parseFloat(plain[1]), parseFloat(plain[2]));

    // A signed number *and* a hemisphere letter is a double negation. Guessing
    // which the user meant would silently place the photo in the wrong
    // hemisphere, so this is rejected rather than resolved.
    if (/-\s*\d+(?:\.\d+)?\s*°?\s*[NSEW]/i.test(text)) return null;

    return null;
  }

  function validated(latitude, longitude) {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    if (latitude < -90 || latitude > 90) return null;
    if (longitude < -180 || longitude > 180) return null;
    return { latitude, longitude };
  }

  /* ── Display decisions ───────────────────────────────────────────────────
     What a value should *say* is logic; putting it in the DOM is not. Keeping
     the two apart means the wording and the empty/mixed distinction can be
     tested without a browser.                                              */

  /**
   * How a resolved field should render: a CSS modifier and the text.
   *
   * `empty` and `mixed` must never look alike. "not set" invites you to type a
   * value; "mixed" warns that typing will overwrite several different ones.
   */
  function describeField(resolution, field) {
    if (resolution.state === 'mixed') {
      return { modifier: 'mixed', text: '—— mixed ——' };
    }
    if (resolution.state === 'empty') {
      return { modifier: 'empty', text: 'not set' };
    }
    const value = resolution.value;
    const text =
      field && field.list && Array.isArray(value) ? value.join(', ') : String(value);
    return { modifier: null, text };
  }

  /** Same, for the GPS row, which is resolved from positions not tags. */
  function describePositions(positions) {
    if (!positions.length) return { modifier: 'empty', text: 'no location' };
    const formatted = positions.map((p) => formatPosition(p));
    if (!formatted.every((f) => f === formatted[0])) {
      return { modifier: 'mixed', text: '—— mixed ——' };
    }
    if (!formatted[0]) return { modifier: 'empty', text: 'no location' };
    return { modifier: null, text: formatted[0] };
  }

  /**
   * Renders one inspector value.
   *
   * Binary tags arrive base64-encoded and run to megabytes; putting one in the
   * DOM verbatim locks the panel up, so they are summarised instead.
   */
  function describeTagValue(value) {
    const raw = typeof value === 'string' ? value : JSON.stringify(value);
    if (raw.startsWith('base64:')) {
      return `(binary, ${raw.length - 'base64:'.length} bytes encoded)`;
    }
    return raw;
  }

  /** Groups a tag object by its ExifTool group prefix, for the inspector. */
  function groupTags(entry) {
    const groups = new Map();
    for (const [key, value] of Object.entries(entry || {})) {
      if (key === 'SourceFile') continue;
      const idx = key.indexOf(':');
      const group = idx === -1 ? 'Other' : key.slice(0, idx);
      const name = idx === -1 ? key : key.slice(idx + 1);
      if (!groups.has(group)) groups.set(group, []);
      // `key` is carried through as well as the split halves. The row shows
      // `name` and the heading shows `group`, but anything that wants to *act*
      // on the tag needs the original — reassembling `${group}:${name}` turns
      // an ungrouped key into the tag `Other:Whatever`, which does not exist
      // and which the write path would happily accept as well-formed.
      groups.get(group).push({ key, name, value });
    }
    // ExifTool emits groups in file order; a stable alphabetical presentation
    // means a tag sits in the same place every time it is looked up.
    return [...groups.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([group, tags]) => ({
        group,
        tags: tags.sort((a, b) => a.name.localeCompare(b.name)),
      }));
  }

  return {
    FIELDS,
    MIXED,
    readField,
    resolveField,
    createSelection,
    selectOnly,
    toggle,
    selectRange,
    selectAll,
    pruneSelection,
    filterEntries,
    basename,
    normalisePath,
    lockedReason,
    isEditableValue,
    countChanges,
    positionOf,
    formatPosition,
    describeField,
    describePositions,
    describeTagValue,
    groupTags,
    buildEdit,
    parseList,
    editIsEmpty,
    summariseEdit,
    parseCoordinates,
    resolvePositions,
    resolveDraftField,
    baselineFor,
    draftIsEmpty,
    EMPTY_DRAFT,
  };
});
