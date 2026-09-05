/**
 * Path handling across the Rust/JS boundary.
 *
 * Two different kinds of path reach the frontend and they do not agree on
 * separators:
 *
 *   * `PhotoEntry.path` comes from Rust and uses the native separator, so it is
 *     backslash-separated on Windows.
 *   * ExifTool's `SourceFile` is always forward-slash separated — it rewrites
 *     every filename argument it is given (`CleanFilename`).
 *
 * On Linux the two are byte-identical for the same file, so nothing that
 * confuses them can fail there. On Windows they never match, and the failures
 * are quiet: a cache that never hits, a map that never draws a marker, a
 * filename that renders as a full path. These are source-level guards because
 * `app.js` is a browser IIFE that needs a `document` to load.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const jsDir = path.join(__dirname, '..', 'www', 'js');
const sources = fs
  .readdirSync(jsDir)
  .filter((name) => name.endsWith('.js'))
  .map((name) => ({ name, text: fs.readFileSync(path.join(jsDir, name), 'utf8') }));

test('the sources were actually found', () => {
  // A glob that quietly matched nothing would make every assertion below pass
  // vacuously.
  assert.ok(sources.length > 5, `only found ${sources.length} frontend sources`);
});

test('no path is split on forward slashes alone', () => {
  // `'C:\\photos\\a.jpg'.split('/').pop()` is the whole path, not the filename.
  // S.basename splits on either separator; use it.
  const offenders = sources
    .filter(({ text }) => /\.split\('\/'\)|\.split\("\/"\)|\.split\(\/\\\/\/\)/.test(text))
    .map(({ name }) => name);
  assert.deepEqual(offenders, [], 'these split a path on "/" only — use S.basename');
});

test('the metadata cache is keyed on the path we asked for, not on SourceFile', () => {
  const app = sources.find((s) => s.name === 'app.js');
  assert.ok(app, 'app.js not found');

  // ExifTool reports SourceFile as its own normalisation of the argument, so a
  // cache keyed on it cannot be read by a lookup keyed on PhotoEntry.path —
  // every hit misses on Windows. The reads (selectedEntries, the geotag
  // selection) have no positional fallback, so the map silently shows nothing.
  assert.doesNotMatch(
    app.text,
    /metadataCache\.set\(\s*entry\.SourceFile/,
    'app.js keys the metadata cache on SourceFile'
  );
  assert.match(
    app.text,
    /metadataCache\.set\(\s*requested\s*,/,
    'app.js should key the cache on the requested path'
  );
  // Pairing by array index would attribute one photo's tags to another as soon
  // as ExifTool omits an unreadable file from the array.
  assert.match(
    app.text,
    /requestedBy\.get\(S\.normalisePath\(entry\.SourceFile\)\)/,
    'results should be paired to requests by normalised name, not by position'
  );
});

test('a result ExifTool omits does not shift the others onto the wrong paths', () => {
  // The pairing logic, reproduced against the real normalisePath. ExifTool
  // drops a file it cannot read from the JSON array rather than returning null
  // for it, so the second result is not necessarily the second request.
  const S = require('../www/js/state.js');
  const missing = [
    'C:\\photos\\a.jpg',
    'C:\\photos\\broken.jpg',
    'C:\\photos\\c.jpg',
  ];
  const results = [
    { SourceFile: 'C:/photos/a.jpg', 'XMP:Title': 'A' },
    // broken.jpg is absent — not null, absent.
    { SourceFile: 'C:/photos/c.jpg', 'XMP:Title': 'C' },
  ];

  const cache = new Map();
  const requestedBy = new Map(missing.map((p) => [S.normalisePath(p), p]));
  for (const entry of results) {
    const requested = entry && requestedBy.get(S.normalisePath(entry.SourceFile));
    if (requested) cache.set(requested, entry);
  }

  assert.equal(cache.get('C:\\photos\\a.jpg')['XMP:Title'], 'A');
  assert.equal(cache.get('C:\\photos\\c.jpg')['XMP:Title'], 'C');
  // The unreadable one must be absent, never holding c.jpg's tags.
  assert.equal(cache.has('C:\\photos\\broken.jpg'), false);
  assert.equal(cache.size, 2);
});

test('Rust never hands out a raw canonicalize() result', () => {
  // std::fs::canonicalize returns the verbatim `\\?\C:\...` form on Windows.
  // ExifTool rewrites it to `//?/C:/...`, which Windows will not open, so every
  // read and write fails with "Error: File not found" while the app otherwise
  // looks healthy. library::canonical strips the prefix; nothing else may
  // canonicalise.
  const rustDir = path.join(__dirname, '..', 'tauri', 'src');
  const offenders = fs
    .readdirSync(rustDir)
    .filter((name) => name.endsWith('.rs'))
    .filter((name) => {
      const text = fs.readFileSync(path.join(rustDir, name), 'utf8');
      return text
        .split('\n')
        .some(
          (line) =>
            /\.canonicalize\(\)/.test(line) &&
            !line.trimStart().startsWith('//') &&
            !/dunce::canonicalize/.test(line)
        );
    });
  assert.deepEqual(offenders, [], 'these call canonicalize() directly — use library::canonical');
});
