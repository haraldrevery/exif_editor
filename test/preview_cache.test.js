/**
 * Preview cache bounds.
 *
 * The cache this replaces was an unbounded `Map` holding data-URI strings. It
 * was harmless only because every value happened to be a ~1.7 KB EXIF
 * thumbnail; nothing in the code said so, and nothing would have complained
 * when something started caching full-size extractions instead.
 *
 * So what is pinned here is the part that fails silently: that both caps are
 * actually enforced, that eviction is least-recently-*used* rather than
 * least-recently-inserted, and that a negative result stays distinguishable
 * from a miss — collapsing those two makes the app re-extract every
 * unextractable file on every scroll, which is invisible except as a slow app.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPreviewCache, sizeOf } = require('../www/js/preview_cache.js');

/** A data URI of a given payload length, so byte budgets can be aimed at. */
const dataUri = (bytes) => `data:image/jpeg;base64,${'A'.repeat(bytes)}`;

/* ── The three-way result ────────────────────────────────────────────────── */

test('a miss, a negative result and a hit are three different answers', () => {
  const cache = createPreviewCache();

  // Never looked at.
  assert.equal(cache.get('/a.jpg'), undefined);

  // Looked at, and it genuinely has no preview. This is what stops the grid
  // re-running an extraction that is known to come back empty.
  cache.set('/a.jpg', null);
  assert.equal(cache.get('/a.jpg'), null);
  assert.ok(cache.has('/a.jpg'));

  cache.set('/b.jpg', 'asset://b.jpg');
  assert.equal(cache.get('/b.jpg'), 'asset://b.jpg');
});

/* ── Sizing ──────────────────────────────────────────────────────────────── */

test('only data URIs are charged — a path is a reference, not a payload', () => {
  // The bytes behind an asset:/file:// URL belong to the webview's own image
  // cache. Charging for them would be double-counting memory we do not hold.
  assert.equal(sizeOf('asset://photos/a.jpg'), 0);
  assert.equal(sizeOf('file:///photos/a.jpg'), 0);
  assert.equal(sizeOf(null), 0);
  assert.ok(sizeOf(dataUri(1000)) > 1000);
});

test('the byte budget counts only what is actually held', () => {
  const cache = createPreviewCache({ maxBytes: 10_000 });
  cache.set('/a.heic', dataUri(1000));
  cache.set('/b.jpg', 'file:///b.jpg');
  cache.set('/c.jpg', null);
  // Three entries, one payload.
  assert.equal(cache.stats().entries, 3);
  assert.ok(cache.stats().bytes > 1000 && cache.stats().bytes < 1200);
});

/* ── Eviction ────────────────────────────────────────────────────────────── */

test('the entry cap bounds cheap entries that cost no bytes', () => {
  // Bytes alone would let a million path-shaped entries accumulate for free.
  const cache = createPreviewCache({ maxEntries: 3 });
  for (const name of ['a', 'b', 'c', 'd']) cache.set(`/${name}.jpg`, `file:///${name}.jpg`);

  assert.equal(cache.stats().entries, 3);
  assert.equal(cache.get('/a.jpg'), undefined, 'the oldest should have gone');
  assert.equal(cache.get('/d.jpg'), 'file:///d.jpg');
});

test('the byte cap bounds expensive entries that are few', () => {
  // Count alone would let a hundred full-size extractions eat a gigabyte.
  const cache = createPreviewCache({ maxEntries: 1000, maxBytes: 5000 });
  cache.set('/a.heic', dataUri(2000));
  cache.set('/b.heic', dataUri(2000));
  assert.equal(cache.stats().entries, 2);

  cache.set('/c.heic', dataUri(2000));
  assert.ok(cache.stats().bytes <= 5000, 'the budget should have been respected');
  assert.equal(cache.get('/a.heic'), undefined, 'the oldest should have gone');
  assert.equal(cache.get('/c.heic'), dataUri(2000));
});

test('eviction is least-recently-used, not least-recently-inserted', () => {
  // The grid scrolls back and forth over the same tiles. An insertion-ordered
  // cache would evict the photo the user keeps returning to, which is exactly
  // the one worth keeping.
  const cache = createPreviewCache({ maxEntries: 3 });
  cache.set('/a.jpg', 'file:///a.jpg');
  cache.set('/b.jpg', 'file:///b.jpg');
  cache.set('/c.jpg', 'file:///c.jpg');

  // Touch the oldest, so it is no longer the least recently used.
  assert.equal(cache.get('/a.jpg'), 'file:///a.jpg');

  cache.set('/d.jpg', 'file:///d.jpg');
  assert.equal(cache.get('/a.jpg'), 'file:///a.jpg', 'the touched entry survived');
  assert.equal(cache.get('/b.jpg'), undefined, 'the untouched one went instead');
});

test('re-setting a path replaces its cost rather than adding to it', () => {
  const cache = createPreviewCache();
  cache.set('/a.heic', dataUri(1000));
  const first = cache.stats().bytes;
  cache.set('/a.heic', dataUri(1000));
  assert.equal(cache.stats().entries, 1);
  assert.equal(cache.stats().bytes, first, 'the byte count double-counted');
});

/* ── Eviction notification ───────────────────────────────────────────────── */

test('onEvict fires for every departure, including clear()', () => {
  // This is what lets the grid drop a stale <img> from a tile that is still on
  // screen. Without it, an edited photo keeps showing its pre-edit thumbnail
  // until it happens to scroll out of view and back — the cache was cleared
  // but the pixels on screen were not.
  const evicted = [];
  const cache = createPreviewCache({
    maxEntries: 2,
    onEvict: (path, url) => evicted.push([path, url]),
  });

  cache.set('/a.jpg', 'file:///a.jpg');
  cache.set('/b.jpg', 'file:///b.jpg');
  cache.set('/c.jpg', 'file:///c.jpg');
  assert.deepEqual(evicted, [['/a.jpg', 'file:///a.jpg']], 'no notice of the overflow');

  evicted.length = 0;
  cache.clear();
  assert.equal(evicted.length, 2, 'clear() evicted silently');
  assert.equal(cache.stats().entries, 0);
  assert.equal(cache.stats().bytes, 0);
});

test('every view sharing the cache is told about an eviction', () => {
  // The grid and the filmstrip draw the same photos from one cache. A single
  // callback slot would mean whichever was constructed second kept showing
  // images the cache had already dropped — the stale-thumbnail bug again, but
  // only in one of the two places, which is far harder to spot.
  const seen = { grid: [], strip: [] };
  const cache = createPreviewCache({
    maxEntries: 1,
    onEvict: (path) => seen.grid.push(path),
  });
  const remove = cache.addEvictListener((path) => seen.strip.push(path));

  cache.set('/a.jpg', 'file:///a.jpg');
  cache.set('/b.jpg', 'file:///b.jpg');
  assert.deepEqual(seen.grid, ['/a.jpg']);
  assert.deepEqual(seen.strip, ['/a.jpg']);

  // A view that goes away stops hearing about it.
  remove();
  cache.set('/c.jpg', 'file:///c.jpg');
  assert.deepEqual(seen.grid, ['/a.jpg', '/b.jpg']);
  assert.deepEqual(seen.strip, ['/a.jpg']);
});

test('one listener throwing does not rob the others of the notice', () => {
  // The entry is already out of the map and its bytes already credited back by
  // the time listeners run. Letting a throw escape would leave the remaining
  // views drawing an image the cache no longer believes in.
  const survived = [];
  const cache = createPreviewCache({
    maxEntries: 1,
    onEvict: () => {
      throw new Error('a view failed to repaint');
    },
  });
  cache.addEvictListener((path) => survived.push(path));

  cache.set('/a.jpg', 'file:///a.jpg');
  cache.set('/b.jpg', 'file:///b.jpg');
  assert.deepEqual(survived, ['/a.jpg']);
  assert.equal(cache.stats().entries, 1);
});

test('clear() survives an onEvict that touches the cache', () => {
  // The grid's callback runs arbitrary DOM work; iterating the live map while
  // it mutates would skip entries and leave bytes charged for nothing.
  const cache = createPreviewCache({
    onEvict: (path) => cache.delete(path),
  });
  cache.set('/a.jpg', 'file:///a.jpg');
  cache.set('/b.jpg', 'file:///b.jpg');
  cache.clear();
  assert.equal(cache.stats().entries, 0);
  assert.equal(cache.stats().bytes, 0);
});

/* ── The oversized entry ─────────────────────────────────────────────────── */

test('an entry larger than the whole budget is kept, not evicted on arrival', () => {
  // A cache that drops what it was just handed looks exactly like a cache
  // miss. The caller re-fetches, stores, is dropped again — a livelock that
  // shows up as one photo pinning a core for the rest of the session. Real:
  // a large TIFF's embedded preview can outweigh a modest byte budget on its
  // own.
  const cache = createPreviewCache({ maxBytes: 1000 });
  const huge = dataUri(50_000);

  cache.set('/enormous.tif', huge);
  assert.equal(cache.get('/enormous.tif'), huge, 'the cache dropped what it was just given');
  assert.equal(cache.stats().entries, 1);

  // The budget is exceeded, but by exactly one entry — and the next arrival
  // displaces it rather than being refused in turn.
  cache.set('/small.jpg', dataUri(10));
  assert.equal(cache.get('/enormous.tif'), undefined, 'the oversized entry should now go');
  assert.equal(cache.get('/small.jpg'), dataUri(10));
  assert.ok(cache.stats().bytes < 1000);
});

test('an oversized arrival still clears out everything else', () => {
  const cache = createPreviewCache({ maxBytes: 1000 });
  cache.set('/a.jpg', dataUri(300));
  cache.set('/b.jpg', dataUri(300));
  cache.set('/enormous.tif', dataUri(50_000));

  // Protecting the newcomer must not protect the rest along with it.
  assert.equal(cache.stats().entries, 1);
  assert.equal(cache.get('/a.jpg'), undefined);
  assert.equal(cache.get('/b.jpg'), undefined);
});

test('deleting one path leaves the rest alone', () => {
  const cache = createPreviewCache();
  cache.set('/a.heic', dataUri(500));
  cache.set('/b.heic', dataUri(500));
  cache.delete('/a.heic');
  assert.equal(cache.get('/a.heic'), undefined);
  assert.equal(cache.get('/b.heic'), dataUri(500));
  assert.equal(cache.stats().entries, 1);
});
