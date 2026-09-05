/**
 * CSV export.
 *
 * Every failure mode here is silent. A caption with a comma in it splits into
 * two columns and the file still opens; a value beginning with `=` runs as a
 * formula instead of being shown; a BOM-less UTF-8 file is mojibake in Excel on
 * Windows and perfect everywhere the developer looked. Nothing throws, so
 * nothing catches these but assertions.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const Csv = require('../www/js/csv.js');

/** A photo as the export sees it: the scan entry plus its ExifTool tags. */
function photo(name, tags) {
  return { name, path: `/photos/${name}`, size: 1024, tags: tags || {} };
}

/** The rows of a built CSV, BOM stripped, without the trailing terminator. */
function rowsOf(csv) {
  const text = csv.replace(/^﻿/, '');
  assert.ok(text.endsWith('\r\n'), 'the file should end with a line terminator');
  return text.slice(0, -2).split('\r\n');
}

/* ── The shape of the file ────────────────────────────────────────────────── */

test('the three columns the export is named for come first, always', () => {
  const csv = Csv.buildCsv({ columns: [], records: [photo('a.jpg')] });
  const [header] = rowsOf(csv);
  assert.equal(header, 'File name,Title,Description');
});

test('extra columns keep the canonical order, not the order they were ticked', () => {
  // Otherwise two exports of the same folder differ by the order someone
  // happened to click, and neither can be diffed against the other.
  const csv = Csv.buildCsv({
    columns: ['rating', 'keywords', 'camera'],
    records: [],
  });
  assert.equal(
    rowsOf(csv)[0],
    'File name,Title,Description,Keywords,Camera,Rating'
  );
});

test('a locked column cannot be dropped by leaving it out', () => {
  const csv = Csv.buildCsv({ columns: ['camera'], records: [photo('a.jpg')] });
  assert.match(rowsOf(csv)[0], /^File name,Title,Description,/);
});

test('the file is CRLF with a BOM', () => {
  // RFC 4180 says CRLF. The BOM is for Excel on Windows, which otherwise reads
  // the file in the system code page — the one platform where an accented
  // caption comes out wrong and nobody thinks to check.
  const csv = Csv.buildCsv({ columns: [], records: [photo('a.jpg')] });
  assert.ok(csv.startsWith('﻿'), 'no BOM');
  assert.ok(csv.includes('\r\n'), 'not CRLF');
  assert.ok(!/[^\r]\n/.test(csv), 'a bare LF got in');
});

test('the BOM can be turned off without disturbing anything else', () => {
  const csv = Csv.buildCsv({ columns: [], records: [], bom: false });
  assert.ok(!csv.startsWith('﻿'));
  assert.equal(rowsOf(csv).length, 1);
});

/* ── Quoting ──────────────────────────────────────────────────────────────── */

test('a comma in a caption does not become a column break', () => {
  const csv = Csv.buildCsv({
    columns: [],
    records: [photo('a.jpg', { 'XMP:Description': 'Oslo, in the rain' })],
  });
  assert.equal(rowsOf(csv)[1], 'a.jpg,,"Oslo, in the rain"');
});

test('a quote is doubled and the field wrapped', () => {
  const csv = Csv.buildCsv({
    columns: [],
    records: [photo('a.jpg', { 'XMP:Title': 'The "good" one' })],
  });
  assert.equal(rowsOf(csv)[1], 'a.jpg,"The ""good"" one",');
});

test('a newline inside a caption stays inside its field', () => {
  // Quoted, so a reader that splits on CRLF sees one record, not two — and the
  // second half does not become a row with everything shifted one column left.
  const csv = Csv.buildCsv({
    columns: [],
    records: [photo('a.jpg', { 'XMP:Description': 'line one\r\nline two' })],
  });
  const text = csv.replace(/^﻿/, '');
  assert.ok(text.includes('"line one\r\nline two"'), text);
});

test('an ordinary value is not quoted', () => {
  // Quoting everything is valid CSV and unreadable in a text editor.
  const csv = Csv.buildCsv({
    columns: [],
    records: [photo('a.jpg', { 'XMP:Title': 'Harbour' })],
  });
  assert.equal(rowsOf(csv)[1], 'a.jpg,Harbour,');
});

/* ── Formula injection ────────────────────────────────────────────────────── */

test('a value a spreadsheet would execute is defused', () => {
  // The metadata in these files was not written by this app, and Excel and
  // LibreOffice run a leading `=` rather than displaying it.
  for (const lead of ['=', '+', '@', '\t']) {
    const value = `${lead}HYPERLINK("http://example.invalid")`;
    assert.equal(Csv.neutralise(value), `'${value}`, `not defused: ${lead}`);
  }
});

test('a negative number is left exactly as it is', () => {
  // The bug this guard exists for: a longitude of -122.4 and an altitude of -3
  // both start with a minus, and prefixing them turns a numeric column into a
  // column of text — which is worse than the problem, and hits every photo
  // taken west of Greenwich.
  for (const value of ['-122.4', '-3', '-0.5', '0', '48.8566']) {
    assert.equal(Csv.neutralise(value), value);
  }
});

test('a leading minus that is not a number is still defused', () => {
  assert.equal(Csv.neutralise('-1+1+cmd'), "'-1+1+cmd");
  assert.equal(Csv.neutralise('- shot at dawn'), "'- shot at dawn");
});

test('the protection can be turned off, and then nothing is altered', () => {
  const records = [photo('a.jpg', { 'XMP:Title': '=SUM(A1)' })];
  const on = Csv.buildCsv({ columns: [], records });
  const off = Csv.buildCsv({ columns: [], records, protectFormulas: false });
  assert.match(rowsOf(on)[1], /'=SUM\(A1\)/);
  assert.equal(rowsOf(off)[1], 'a.jpg,=SUM(A1),');
});

test('the apostrophe goes inside the quotes, not before them', () => {
  // Outside, it would be a stray character before the field rather than part
  // of it, and the row would no longer parse.
  const csv = Csv.buildCsv({
    columns: [],
    records: [photo('a.jpg', { 'XMP:Title': '=A1,B2' })],
  });
  assert.equal(rowsOf(csv)[1], `a.jpg,"'=A1,B2",`);
});

/* ── Values ───────────────────────────────────────────────────────────────── */

test('a field is read through the same priority order the Edit panel uses', () => {
  // Title lives in XMP or IPTC and description in three places. A second copy
  // of that order here would drift, and the CSV would then disagree with the
  // app that produced it.
  const xmp = photo('a.jpg', { 'XMP:Title': 'from xmp', 'IPTC:ObjectName': 'from iptc' });
  const iptc = photo('b.jpg', { 'IPTC:ObjectName': 'from iptc' });
  const exif = photo('c.jpg', { 'EXIF:ImageDescription': 'from exif' });
  const rows = rowsOf(Csv.buildCsv({ columns: [], records: [xmp, iptc, exif] }));
  assert.equal(rows[1], 'a.jpg,from xmp,');
  assert.equal(rows[2], 'b.jpg,from iptc,');
  assert.equal(rows[3], 'c.jpg,,from exif');
});

test('keywords arrive as a list and leave as one cell', () => {
  const csv = Csv.buildCsv({
    columns: ['keywords'],
    records: [photo('a.jpg', { 'XMP:Subject': ['oslo', 'rain', 'winter'] })],
  });
  assert.match(rowsOf(csv)[1], /oslo; rain; winter/);
});

test('a single keyword, which ExifTool sends as a bare string, still works', () => {
  const csv = Csv.buildCsv({
    columns: ['keywords'],
    records: [photo('a.jpg', { 'IPTC:Keywords': 'oslo' })],
  });
  assert.equal(rowsOf(csv)[1], 'a.jpg,,,oslo');
});

test('a coordinate is not printed with floating-point noise', () => {
  // The engine reads with -n, so these arrive as raw doubles.
  assert.equal(Csv.formatNumber(59.9138888888889), '59.913889');
  assert.equal(Csv.formatNumber(-10.75), '-10.75');
  assert.equal(Csv.formatNumber(4000), '4000');
});

test('a capture time comes out as a spreadsheet can read it', () => {
  // EXIF writes `2024:05:01`, and a column of those sorts as text.
  assert.equal(Csv.formatExifDate('2024:05:01 12:30:00'), '2024-05-01 12:30:00');
  // Only the date half, and only when it is exactly EXIF's shape.
  assert.equal(Csv.formatExifDate('12:30:00'), '12:30:00');
  assert.equal(Csv.formatExifDate('not a date'), 'not a date');
});

test('the date column is converted, not just the helper', () => {
  const csv = Csv.buildCsv({
    columns: ['dateTaken'],
    records: [photo('a.jpg', { 'EXIF:DateTimeOriginal': '2024:05:01 12:30:00' })],
  });
  assert.equal(rowsOf(csv)[1], 'a.jpg,,,2024-05-01 12:30:00');
});

test('a photo with no metadata at all is still a row', () => {
  // A file ExifTool could not read is written with only its name. Silently
  // dropping it would make the row count disagree with the folder, which is
  // the first thing anyone checks an export against.
  const csv = Csv.buildCsv({ columns: ['camera'], records: [photo('broken.jpg')] });
  assert.equal(rowsOf(csv)[1], 'broken.jpg,,,');
});

test('the scan entry supplies the columns ExifTool has no tag for', () => {
  const csv = Csv.buildCsv({
    columns: ['size', 'path'],
    records: [photo('a.jpg')],
  });
  assert.equal(rowsOf(csv)[1], 'a.jpg,,,1024,/photos/a.jpg');
});

/* ── What gets asked of the engine ────────────────────────────────────────── */

test('only the tags the chosen columns need are requested', () => {
  const tags = Csv.tagsFor(['filename', 'title', 'description', 'size']);
  assert.deepEqual(tags, [
    'XMP:Title',
    'IPTC:ObjectName',
    'XMP:Description',
    'IPTC:Caption-Abstract',
    'EXIF:ImageDescription',
  ]);
});

test('a tag two columns share is asked for once', () => {
  const tags = Csv.tagsFor(Csv.COLUMNS.map((column) => column.key));
  assert.equal(new Set(tags).size, tags.length, `duplicates in ${tags}`);
});

test('every requested tag carries its group', () => {
  // The core refuses an ungrouped name, because each of these is written out
  // as `-{tag}` on ExifTool's own command line and its options are ungrouped
  // words — a bare `execute` would end the batch early. A column whose tag did
  // not match would fail at run time, in the shell nobody was testing in.
  const shape = /^[A-Za-z0-9-]+:[A-Za-z0-9-]+$/;
  for (const tag of Csv.tagsFor(Csv.COLUMNS.map((column) => column.key))) {
    assert.match(tag, shape, `the core would reject ${tag}`);
  }
});

test('the GPS columns read the signed Composite values', () => {
  // The raw EXIF tags are unsigned magnitudes with the hemisphere held
  // separately, so reading those puts every southern and western photo on the
  // wrong side of the planet.
  for (const key of ['latitude', 'longitude']) {
    assert.deepEqual(Csv.tagsFor([key]).filter((t) => t.startsWith('Composite:')).length, 1);
    assert.equal(Csv.tagsFor([key]).some((t) => t.startsWith('EXIF:')), false);
  }
  const csv = Csv.buildCsv({
    columns: ['latitude', 'longitude'],
    records: [
      photo('south.jpg', {
        'Composite:GPSLatitude': -33.8688,
        'Composite:GPSLongitude': 151.2093,
      }),
    ],
  });
  assert.equal(rowsOf(csv)[1], 'south.jpg,,,-33.8688,151.2093');
});

/* ── The suggested file name ──────────────────────────────────────────────── */

test('the save dialog is offered a name derived from the folder', () => {
  assert.equal(Csv.suggestedName('/home/someone/Pictures/Iceland'), 'Iceland-metadata.csv');
  assert.equal(Csv.suggestedName(''), 'photos-metadata.csv');
  assert.equal(Csv.suggestedName(null), 'photos-metadata.csv');
});

test('a folder name the filesystem would refuse does not reach the dialog', () => {
  assert.equal(Csv.suggestedName('/photos/trip: 2024'), 'trip- 2024-metadata.csv');
});
