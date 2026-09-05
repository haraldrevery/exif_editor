/**
 * What `heic.js` asks the worker for, and what it remembers.
 *
 * `www/js/heic_worker.js` gets the marshalling right — that is pinned next
 * door, against the real wasm. This file pins the layer above it, where the
 * failure mode is not an error but a slow app: three numbers travel together
 * through every one of these calls, and swapping any two of them still
 * produces a correct-looking thumbnail.
 *
 *   * `maxEdge`  — what the result is stored at, and the disk cache key.
 *   * `minEdge`  — the smallest thumbnail *item* worth taking instead of
 *                  decoding the primary image.
 *   * whether "no item that big" is an answer or a reason to decode.
 *
 * The bug this was written for: the grid's last resort passed its 512 px store
 * size as the floor as well, so every file whose `thmb` item was the usual
 * 256x192 or 320x240 was declined and its full frame decoded instead. Nothing
 * looked wrong; the folder was just slow, and the wasm decoder did in seconds
 * what the platform thumbnailer next to it does in milliseconds.
 *
 * No decoder is needed here — the worker is faked, because what is being
 * checked is the request, not the decode.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '../www/js/heic.js'), 'utf8');

const PATH = '/photos/a.heic';
const STORE_EDGE = 512;
const FLOOR = 224;
const PREFIX = 'data:image/jpeg;base64,';
const URI = `${PREFIX}AAAA`;

/**
 * Loads `heic.js` against a fake worker and a fake shell, and reports what it
 * asked for.
 *
 * `answer` is called with each posted message and returns the reply, so a test
 * can be a file that has a thumbnail item, one that has none, or a decoder that
 * is not there at all.
 */
function loadHeic({ answer, cached = null } = {}) {
  const posted = [];
  const reads = [];
  const written = [];

  const sandbox = { console, setTimeout, clearTimeout, atob, URL, ImageData: class {} };
  sandbox.globalThis = sandbox;

  // Only ever reached once a decode has succeeded; the pixels never leave here.
  sandbox.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ drawImage() {}, putImageData() {}, imageSmoothingQuality: '' }),
      toDataURL: () => URI,
    }),
  };

  sandbox.Worker = class {
    constructor() {
      this.listeners = {};
    }
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    }
    postMessage(message) {
      posted.push(message);
      const reply = answer(message);
      if (reply) setTimeout(() => this.listeners.message({ data: { id: message.id, ...reply } }), 0);
    }
  };

  sandbox.window = {
    NativeAPI: {
      reportRenderer() {},
      async readFileBytes(file) {
        reads.push(file);
        return 'AAAA';
      },
      async readThumbCache(file, edge) {
        return cached && cached.path === file && cached.edge === edge ? cached.base64 : null;
      },
      async writeThumbCache(file, edge, base64) {
        written.push({ path: file, edge, base64 });
      },
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'heic.js' });
  return { heic: sandbox.window.ExifHeic, posted, reads, written };
}

/** A reply carrying pixels of the given size, as the real worker sends them. */
const decoded = (width, height) => ({
  ok: true,
  width,
  height,
  buffer: new ArrayBuffer(width * height * 4),
});

const declined = { ok: false, error: 'no thumbnail item that size' };

/* ── The floor is the floor, and the ceiling is the ceiling ──────────────── */

test('the last resort asks for the floor, not the size it stores at', async () => {
  // The regression. Asking for 512 here declines the 256 and 320 px items that
  // real files carry, and the worker then decodes the full frame instead.
  const { heic, posted } = loadHeic({ answer: () => decoded(320, 240) });

  await heic.decodeToThumbnail(PATH, STORE_EDGE, FLOOR);

  assert.equal(posted.length, 1);
  assert.equal(posted[0].maxEdge, FLOOR);
  assert.ok(!posted[0].thumbnailOnly, 'the last resort must still be able to decode the primary');
});

test('the embedded-thumbnail route asks for the floor too, and takes no for an answer', async () => {
  const { heic, posted } = loadHeic({ answer: () => decoded(320, 240) });

  await heic.decodeEmbeddedThumbnail(PATH, STORE_EDGE, FLOOR);

  assert.equal(posted[0].maxEdge, FLOOR);
  assert.equal(posted[0].thumbnailOnly, true);
});

test('a caller that names only one edge gets it used for both', async () => {
  const { heic, posted } = loadHeic({ answer: () => decoded(256, 192) });

  await heic.decodeToThumbnail(PATH, 256);

  assert.equal(posted[0].maxEdge, 256, 'with no floor given, the store size is the floor');
});

test('the result is remembered under the store size, not the floor', async () => {
  const { heic, written } = loadHeic({ answer: () => decoded(320, 240) });

  await heic.decodeToThumbnail(PATH, STORE_EDGE, FLOOR);

  assert.deepEqual(written, [{ path: PATH, edge: STORE_EDGE, base64: 'AAAA' }]);
});

/* ── What is not asked twice ─────────────────────────────────────────────── */

test('a cached thumbnail costs neither a read nor a decode', async () => {
  const { heic, posted, reads } = loadHeic({
    answer: () => decoded(320, 240),
    cached: { path: PATH, edge: STORE_EDGE, base64: 'CACHED' },
  });

  assert.equal(await heic.decodeEmbeddedThumbnail(PATH, STORE_EDGE, FLOOR), `${PREFIX}CACHED`);
  assert.deepEqual(reads, [], 'a hit must not read the file');
  assert.deepEqual(posted, [], 'a hit must not reach the worker');
});

test('a file with no thumbnail item is only asked once', async () => {
  const { heic, reads } = loadHeic({ answer: () => declined });

  assert.equal(await heic.decodeEmbeddedThumbnail(PATH, STORE_EDGE, FLOOR), null);
  assert.equal(await heic.decodeEmbeddedThumbnail(PATH, STORE_EDGE, FLOOR), null);

  // Answering costs a whole-file read: libheif has to parse the container
  // before anything can say there is nothing in it.
  assert.equal(reads.length, 1, 'the second ask should have been answered from memory');
});

test('the negative is about the floor, so a lower one is still asked', async () => {
  const { heic, reads } = loadHeic({ answer: () => declined });

  await heic.decodeEmbeddedThumbnail(PATH, STORE_EDGE, FLOOR);
  await heic.decodeEmbeddedThumbnail(PATH, STORE_EDGE, 160);

  // "No item of at least 224 px" says nothing about a request for 160.
  assert.equal(reads.length, 2);
});

test('the last resort does not inherit the thumbnail route\'s no', async () => {
  let asked = 0;
  const { heic, reads } = loadHeic({
    answer: () => (asked++ === 0 ? declined : decoded(4032, 3024)),
  });

  assert.equal(await heic.decodeEmbeddedThumbnail(PATH, STORE_EDGE, FLOOR), null);
  // Same path, same floor — but "this file has no thumbnail item" is not
  // "this file has no preview". Skipping the decode here would caption a
  // perfectly good photo "No preview" for the rest of the session.
  assert.equal(await heic.decodeToThumbnail(PATH, STORE_EDGE, FLOOR), URI);
  assert.equal(reads.length, 2);
});

test('forgetting a path makes it askable again', async () => {
  const { heic, reads } = loadHeic({ answer: () => declined });

  await heic.decodeEmbeddedThumbnail(PATH, STORE_EDGE, FLOOR);
  await heic.decodeEmbeddedThumbnail(PATH, STORE_EDGE, FLOOR);
  assert.equal(reads.length, 1);

  // Called after a write: the file on disk is no longer the file that was
  // asked about, and the disk cache's mtime key cannot see an in-memory set.
  heic.forget(PATH);
  await heic.decodeEmbeddedThumbnail(PATH, STORE_EDGE, FLOOR);
  assert.equal(reads.length, 2);

  heic.forget();
  await heic.decodeEmbeddedThumbnail(PATH, STORE_EDGE, FLOOR);
  assert.equal(reads.length, 3);
});

test('forgetting one path leaves its neighbours alone', async () => {
  const other = '/photos/b.heic';
  const { heic, reads } = loadHeic({ answer: () => declined });

  await heic.decodeEmbeddedThumbnail(PATH, STORE_EDGE, FLOOR);
  await heic.decodeEmbeddedThumbnail(other, STORE_EDGE, FLOOR);
  heic.forget(other);

  await heic.decodeEmbeddedThumbnail(PATH, STORE_EDGE, FLOOR);
  assert.equal(reads.length, 2, `${PATH} should still be remembered as having none`);
});

/* ── What the grid actually passes ───────────────────────────────────────── */

const grid = fs.readFileSync(path.join(__dirname, '../www/js/grid.js'), 'utf8');

test('the grid passes a floor on both of its decoding routes', () => {
  // Structural, because the alternative is a DOM harness for a virtualised
  // grid. What matters is that neither call site is left to default its floor
  // to the 512 px store size, which is the regression this file exists for.
  for (const call of ['decodeEmbeddedThumbnail', 'decodeToThumbnail']) {
    const at = grid.indexOf(`ExifHeic.${call}(`);
    assert.notEqual(at, -1, `grid.js no longer calls ${call}`);
    const args = grid.slice(at, grid.indexOf(');', at));
    assert.ok(
      args.includes('THUMBNAIL_DECODE_EDGE') && args.includes('THUMBNAIL_ITEM_MIN_EDGE'),
      `${call} must be given both the store size and the floor, not just one`
    );
  }
});

test('the floor is well below the size thumbnails are stored at', () => {
  const value = (name) => Number(new RegExp(`const ${name} = (\\d+)`).exec(grid)[1]);

  // Common `thmb` items are 256x192 and 320x240. A floor at or above the store
  // size declines all of them — which is exactly the bug — so this is the
  // relationship, not the numbers, that has to hold.
  assert.ok(
    value('THUMBNAIL_ITEM_MIN_EDGE') < value('THUMBNAIL_DECODE_EDGE'),
    'the floor must leave room for the thumbnail sizes real files carry'
  );
});

test('the tile-size gate is a separate number from the floor', () => {
  // They were one constant, which meant the gate could not be moved without
  // silently changing which thumbnail items are accepted and cached. Two
  // questions — "is this tile big enough to want a sharper source" and "is this
  // item sharp enough to be worth taking" — that only coincidentally had the
  // same answer.
  assert.match(grid, /const THUMBNAIL_ITEM_MIN_EDGE = \d+;/);

  // And the gate must not exclude the size the grid opens at, or the sharper
  // route is dead code until the user enlarges the tiles.
  assert.match(grid, /const SHARP_TILE_MIN = DEFAULT_TILE_SIZE;/);
});
