/**
 * csv.js — what a metadata export actually contains, and how it is spelled.
 *
 * Pure logic, no DOM and no NativeAPI. Loaded as a global in the app and
 * required directly by `test/csv.test.js`, because every interesting failure
 * here is silent: a caption containing a comma splits into two columns and the
 * file still opens, a value beginning with `=` runs as a formula, and a UTF-8
 * file with no BOM is mojibake in Excel on Windows. None of those throw.
 *
 * # The columns are defined once
 *
 * A field's value comes from `ExifState.readField`, the same lookup the Edit
 * panel renders from. Title lives in `XMP:Title` *or* `IPTC:ObjectName` and
 * description in three places; a second copy of that priority order here would
 * drift from the panel, and the export would then disagree with the app that
 * produced it.
 */

(function (root, factory) {
  'use strict';
  const state =
    typeof module === 'object' && module.exports
      ? require('./state.js')
      : root.ExifState;
  const api = factory(state);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.ExifCsv = api;
  }
})(typeof self !== 'undefined' ? self : this, function (S) {
  'use strict';

  /** How a multi-value field (keywords, creator) is written into one cell. */
  const LIST_SEPARATOR = '; ';

  /* ── Columns ──────────────────────────────────────────────────────────────
     Order here is the order in the file, whatever order the checkboxes were
     ticked in. The first three are the export: a row is a file name, its title
     and its description. Everything after them is opt-in.

     `field` names an entry in `ExifState.FIELDS` and inherits its tag priority.
     `tags` is for the handful of values the edit panel has no field for, read
     in the same first-one-present order.                                   */
  const COLUMNS = [
    { key: 'filename', label: 'File name', source: 'name', locked: true },
    { key: 'title', label: 'Title', field: 'title', locked: true },
    { key: 'description', label: 'Description', field: 'description', locked: true },
    { key: 'keywords', label: 'Keywords', field: 'keywords' },
    { key: 'creator', label: 'Creator', field: 'creator' },
    { key: 'copyright', label: 'Copyright', field: 'copyright' },
    { key: 'dateTaken', label: 'Date taken', field: 'dateTaken', date: true },
    { key: 'camera', label: 'Camera', field: 'camera' },
    { key: 'lens', label: 'Lens', field: 'lens' },
    { key: 'rating', label: 'Rating', field: 'rating' },
    // Composite, not EXIF: the raw EXIF values are unsigned magnitudes with the
    // hemisphere in a separate tag, so reading them directly puts every
    // southern and western photo on the wrong side of the planet.
    { key: 'latitude', label: 'Latitude', tags: ['Composite:GPSLatitude'] },
    { key: 'longitude', label: 'Longitude', tags: ['Composite:GPSLongitude'] },
    { key: 'altitude', label: 'Altitude (m)', tags: ['Composite:GPSAltitude'] },
    {
      key: 'width',
      label: 'Width',
      tags: ['File:ImageWidth', 'EXIF:ImageWidth', 'EXIF:ExifImageWidth'],
    },
    {
      key: 'height',
      label: 'Height',
      tags: ['File:ImageHeight', 'EXIF:ImageHeight', 'EXIF:ExifImageHeight'],
    },
    { key: 'size', label: 'File size (bytes)', source: 'size' },
    { key: 'path', label: 'Full path', source: 'path' },
  ];

  /** The three that are always written, in the order they appear. */
  const LOCKED = COLUMNS.filter((column) => column.locked).map((column) => column.key);

  /**
   * The ExifTool tags a set of columns needs, deduplicated.
   *
   * The point of asking for these by name rather than reading the whole tag
   * set is size: a full `-j -G` dump is 10–25 KB per file, and the handful of
   * tags an export actually uses is under half a kilobyte. Over a few thousand
   * photos that is the difference between a request that completes and one
   * that hits the engine's timeout.
   */
  function tagsFor(keys) {
    const wanted = new Set(keys);
    const tags = [];
    for (const column of COLUMNS) {
      if (!wanted.has(column.key)) continue;
      const list = column.field
        ? (S.FIELDS.find((f) => f.key === column.field) || { tags: [] }).tags
        : column.tags || [];
      for (const tag of list) if (!tags.includes(tag)) tags.push(tag);
    }
    return tags;
  }

  /* ── Values ────────────────────────────────────────────────────────────── */

  /** Renders one ExifTool value as text. */
  function coerce(value) {
    if (value === undefined || value === null) return '';
    if (Array.isArray(value)) {
      return value.map(coerce).filter((part) => part !== '').join(LIST_SEPARATOR);
    }
    if (typeof value === 'number') return formatNumber(value);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    return String(value);
  }

  /**
   * A number as a spreadsheet should see it.
   *
   * The engine reads with `-n`, so coordinates arrive as raw doubles and
   * printing them straight gives `12.345678900000001`. Six decimal places is
   * about 11 cm of latitude — well past what any camera knows.
   */
  function formatNumber(value) {
    if (!Number.isFinite(value)) return '';
    if (Number.isInteger(value)) return String(value);
    return String(Number(value.toFixed(6)));
  }

  /**
   * EXIF's `2024:05:01 12:00:00` as `2024-05-01 12:00:00`.
   *
   * Only the date half is touched, and only when it is exactly EXIF's shape.
   * Colons where a spreadsheet expects hyphens mean the column arrives as text
   * and cannot be sorted or filtered as a date, which is most of the reason to
   * put a timestamp in a CSV at all.
   */
  function formatExifDate(text) {
    return text.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
  }

  /** One column's cell for one photo, before escaping. */
  function cellFor(record, column) {
    if (column.source) return coerce((record || {})[column.source]);
    const tags = (record || {}).tags || {};
    if (column.field) {
      const field = S.FIELDS.find((f) => f.key === column.field);
      const value = field ? S.readField(tags, field) : null;
      const text = coerce(value);
      return column.date ? formatExifDate(text) : text;
    }
    for (const tag of column.tags || []) {
      const value = tags[tag];
      if (value === undefined || value === null || value === '') continue;
      const text = coerce(value);
      return column.date ? formatExifDate(text) : text;
    }
    return '';
  }

  /* ── Spelling it ───────────────────────────────────────────────────────── */

  /** A value a spreadsheet would treat as a formula rather than as text. */
  const RISKY_LEAD = /^[=+\-@\t\r]/;
  /** A bare number — including a negative one, which is not a formula. */
  const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?$/;

  /**
   * Defuses a value that Excel or LibreOffice would execute.
   *
   * Metadata comes out of files this app did not write, and a description of
   * `=HYPERLINK("http://…")` or `@SUM(…)` is run on open, not displayed. The
   * fix is the conventional one: a leading apostrophe, which spreadsheets
   * consume as "the rest of this is text".
   *
   * The number guard is the part that is easy to get wrong. A longitude of
   * `-122.4` and an altitude of `-3` both begin with a minus, and prefixing
   * those turns a coordinate column into a column of strings — so anything
   * that is wholly a number is left exactly as it is.
   */
  function neutralise(text) {
    if (!RISKY_LEAD.test(text)) return text;
    if (PLAIN_NUMBER.test(text)) return text;
    return `'${text}`;
  }

  /**
   * One field, quoted per RFC 4180.
   *
   * Captions contain commas and quotes routinely and newlines often enough to
   * matter. Getting this wrong does not produce a broken file — it produces a
   * file that opens with the columns silently shifted from one row onwards.
   */
  function escapeCell(text) {
    const value = text === undefined || text === null ? '' : String(text);
    if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
    return value;
  }

  /**
   * The whole file.
   *
   * `records` are `{ name, path, size, tags }`, already in the order the rows
   * should appear. `columns` is a set of column keys; the three locked ones are
   * written whether or not they are in it, and the order is always the order in
   * `COLUMNS`.
   *
   * CRLF and a BOM because the destination is a spreadsheet. RFC 4180 specifies
   * CRLF, and Excel on Windows reads a BOM-less UTF-8 file in the system code
   * page — which turns every accented name in the export into mojibake, on the
   * one platform where nobody would think to check.
   */
  function buildCsv({ columns, records, protectFormulas = true, bom = true }) {
    const wanted = new Set([...LOCKED, ...(columns || [])]);
    const chosen = COLUMNS.filter((column) => wanted.has(column.key));

    const lines = [chosen.map((column) => escapeCell(column.label)).join(',')];
    for (const record of records || []) {
      lines.push(
        chosen
          .map((column) => {
            const cell = cellFor(record, column);
            return escapeCell(protectFormulas ? neutralise(cell) : cell);
          })
          .join(',')
      );
    }
    // A trailing terminator, not a trailing blank row: every line ends the same
    // way, which is what a reader that splits on CRLF expects.
    return (bom ? '﻿' : '') + lines.join('\r\n') + '\r\n';
  }

  /** A default name for the save dialog, derived from the folder. */
  function suggestedName(folderPath) {
    const base = folderPath ? S.basename(folderPath) : '';
    // Anything the filesystem might refuse, replaced rather than passed on.
    const safe = base.replace(/[\\/:*?"<>|]/g, '-').trim();
    return `${safe || 'photos'}-metadata.csv`;
  }

  return {
    COLUMNS,
    LOCKED,
    LIST_SEPARATOR,
    tagsFor,
    cellFor,
    coerce,
    formatNumber,
    formatExifDate,
    neutralise,
    escapeCell,
    buildCsv,
    suggestedName,
  };
});
