/**
 * HEIC thumbnail-item decoding, against the real decoder and a real file.
 *
 * This is pinned by a test rather than left to hand-checking because of *how*
 * it fails. The vendored bundle exposes libheif's thumbnail functions as raw
 * wasm exports taking integer pointers, while the neighbouring functions of
 * the same family are embind bindings taking wrapper objects — and the two are
 * indistinguishable by name. Get it wrong in one direction and embind throws;
 * get it wrong in the other and the raw side coerces the object to 0 and
 * reports, perfectly calmly, that the file has no thumbnail. The app would
 * then fall back to a full-resolution decode for every tile and still look
 * correct, just slow. Nothing else in the suite would notice.
 *
 * `heif_image_handle_get_thumbnail` also returns a 12-byte struct by value,
 * which the wasm32 ABI turns into a prepended out-pointer argument. That is an
 * assumption about a calling convention, and this is where it gets checked.
 *
 * Skipped, not failed, when the decoder has not been vendored: it is an
 * optional LGPL component (`build_tools/fetch_heic_decoder.py`) and the app is
 * expected to build and run without it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const BUNDLE = path.join(__dirname, '../www/vendor/libheif/libheif-bundle.js');
const WORKER = path.join(__dirname, '../www/js/heic_worker.js');
const FIXTURE = path.join(__dirname, 'fixtures/phone.heic');

const { decodeThumbnailItem, copyInterleaved } = require('../www/js/heic_worker.js');

const haveDecoder = fs.existsSync(BUNDLE);

/**
 * A worker-shaped realm.
 *
 * A vm context rather than a plain `require` because both the bundle and the
 * worker are written for one: they assign to `self` and expect it to *be* the
 * global scope. One realm for both, because embind's `std::string` binding
 * does an `instanceof Uint8Array` check against the constructor it can see, and
 * an array from another realm fails it.
 */
function makeSandbox() {
  const sandbox = {
    console,
    TextDecoder,
    TextEncoder,
    URL,
    performance,
    setTimeout,
    clearTimeout,
    FinalizationRegistry,
    process,
    Buffer,
    require,
    __dirname: path.dirname(BUNDLE),
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.module = { exports: {} };
  sandbox.exports = sandbox.module.exports;
  return vm.createContext(sandbox);
}

/** Loads the bundle into its own realm and returns the libheif module object. */
async function loadDecoder() {
  const sandbox = makeSandbox();
  vm.runInContext(fs.readFileSync(BUNDLE, 'utf8'), sandbox, { filename: BUNDLE });

  let api = sandbox.libheif;
  if (typeof api === 'function') api = await api();
  return { api, sandbox };
}

/**
 * Loads `heic_worker.js` itself, wired to a real decoder, and captures what it
 * posts back.
 *
 * The api comes from the worker's own `ensureDecoder` rather than from a second
 * load of the bundle: an Emscripten factory called twice yields two independent
 * wasm instances with two independent heaps, and a test that watched the wrong
 * one would pass regardless.
 */
async function loadWorker() {
  const sandbox = makeSandbox();
  const posted = [];
  sandbox.self.postMessage = (message) => posted.push(message);
  sandbox.self.importScripts = () => {
    vm.runInContext(fs.readFileSync(BUNDLE, 'utf8'), sandbox, { filename: BUNDLE });
  };
  vm.runInContext(fs.readFileSync(WORKER, 'utf8'), sandbox, { filename: WORKER });

  const worker = sandbox.module.exports;
  const api = await worker.ensureDecoder();
  return { worker, api, sandbox, posted };
}

/**
 * The bytes, as a typed array belonging to the bundle's own realm.
 *
 * embind's `std::string` binding does an `instanceof Uint8Array` check against
 * the constructor it can see, and a host-realm array fails it. Only an artifact
 * of testing across a vm boundary — in a worker there is one realm.
 */
function loadFixture(sandbox, file) {
  const raw = fs.readFileSync(file);
  const bytes = vm.runInContext(`new Uint8Array(${raw.length})`, sandbox);
  bytes.set(raw);
  return bytes;
}

async function primaryHandle(api, sandbox) {
  const images = new api.HeifDecoder().decode(loadFixture(sandbox, FIXTURE));
  assert.ok(images.length, 'the fixture should hold at least one image');
  return images[0];
}

test('the fixture still has the thumbnail item this all depends on', { skip: !haveDecoder }, async () => {
  const { api, sandbox } = await loadDecoder();
  const image = await primaryHandle(api, sandbox);

  // If this ever reads 0, the interesting question is whether the fixture
  // changed or the calling convention did. See the header.
  const count = api.heif_image_handle_get_number_of_thumbnails(image.handle.$$.ptr);
  assert.equal(count, 1, 'phone.heic carries exactly one thmb-referenced item');
  assert.equal(image.get_width(), 640);
  assert.equal(image.get_height(), 480);
});

test('the thumbnail item decodes to its own dimensions, not the primary\'s', { skip: !haveDecoder }, async () => {
  const { api, sandbox } = await loadDecoder();
  const image = await primaryHandle(api, sandbox);

  const thumb = decodeThumbnailItem(api, image.handle, 256);
  assert.ok(thumb, 'a 256 px request should be served by the 256x192 thumbnail');
  assert.equal(thumb.width, 256);
  assert.equal(thumb.height, 192);
  assert.equal(thumb.data.length, 256 * 192 * 4, 'RGBA, one byte per channel');
});

test('the pixels are an image, not an empty or uniform buffer', { skip: !haveDecoder }, async () => {
  const { api, sandbox } = await loadDecoder();
  const image = await primaryHandle(api, sandbox);
  const thumb = decodeThumbnailItem(api, image.handle, 256);

  // A mis-marshalled decode tends to produce all-zero or all-identical bytes,
  // which the dimension checks above would happily accept.
  const colours = new Set();
  for (let i = 0; i < thumb.data.length; i += 4 * 97) {
    colours.add(`${thumb.data[i]},${thumb.data[i + 1]},${thumb.data[i + 2]}`);
  }
  assert.ok(colours.size > 20, `expected varied pixels, saw ${colours.size} distinct`);

  // Alpha is opaque for an interleaved RGBA decode of an opaque source.
  assert.equal(thumb.data[3], 255);
});

test('the floor decides, and the boundary is inclusive', { skip: !haveDecoder }, async () => {
  const { api, sandbox } = await loadDecoder();
  const image = await primaryHandle(api, sandbox);

  // The item is 256x192. Ask for more than it has and it declines.
  assert.equal(decodeThumbnailItem(api, image.handle, 512), null);
  assert.equal(decodeThumbnailItem(api, image.handle, 288), null);
  // The boundary itself is good enough: >=, not >.
  assert.ok(decodeThumbnailItem(api, image.handle, 256));
  // And the floor the grid actually passes — `THUMBNAIL_ITEM_MIN_EDGE` in
  // grid.js, the smallest item worth taking over the alternative.
  // Pinned because it is the number that decides whether real files take the
  // cheap path at all: raise it to the 512 the result is *stored* at and this
  // fixture, and the 256/320 px items cameras commonly write, all fall back to
  // the worse image after paying for the read anyway.
  assert.ok(decodeThumbnailItem(api, image.handle, 224));
});

test('a malformed handle is declined rather than thrown', { skip: !haveDecoder }, async () => {
  const { api } = await loadDecoder();

  // The worker falls through to the full decode on null; it must not have to
  // catch for the ordinary "no wrapper" cases.
  assert.equal(decodeThumbnailItem(api, null, 256), null);
  assert.equal(decodeThumbnailItem(api, {}, 256), null);
  assert.equal(decodeThumbnailItem(api, { $$: { ptr: 0 } }, 256), null);
});

test('declining is cheap enough to be the common answer', { skip: !haveDecoder }, async () => {
  const { api, sandbox } = await loadDecoder();
  const image = await primaryHandle(api, sandbox);

  // The grid asks every large HEIC tile this question, so a "no" must cost a
  // container parse and not a full-resolution decode. `decodeThumbnailItem`
  // returning null rather than falling back is what makes that true; the
  // worker's `thumbnailOnly` flag is what carries it out to the caller.
  assert.equal(decodeThumbnailItem(api, image.handle, 4096), null);
});

/* ── What the worker frees ───────────────────────────────────────────────── */

/**
 * A message shaped like the ones `heic.js` posts, in the worker's own realm.
 *
 * The bytes have to be re-read per call: `handleMessage` neuters the buffer by
 * transferring it, exactly as a real `postMessage` would.
 */
function decodeRequest(sandbox, id, maxEdge, thumbnailOnly) {
  return { data: { id, bytes: loadFixture(sandbox, FIXTURE).buffer, maxEdge, thumbnailOnly } };
}

/**
 * Where the allocator would put the next block — a proxy for the high-water
 * mark of the wasm heap.
 *
 * Freed immediately, so the probe itself does not move it: a leak shows up as
 * this number climbing across otherwise identical decodes.
 */
function allocatorTop(api) {
  const ptr = api._malloc(64);
  api._free(ptr);
  return ptr;
}

test('a decode releases everything it allocated', { skip: !haveDecoder }, async () => {
  const { worker, api, sandbox, posted } = await loadWorker();

  // One decode first, so any one-off allocation the decoder makes on its first
  // use is behind us and the baseline is a steady state.
  await worker.handleMessage(decodeRequest(sandbox, 0, 224, true));
  const before = allocatorTop(api);

  for (let i = 1; i <= 60; i += 1) {
    // Both paths: the thumbnail item, and — every tenth — the full-resolution
    // decode of the primary image, which allocates far more.
    await worker.handleMessage(decodeRequest(sandbox, i, i % 10 === 0 ? 0 : 224, i % 10 !== 0));
  }

  assert.equal(posted.length, 61, 'every request should have been answered');
  assert.ok(posted.every((message) => message.ok), 'no decode should have failed');

  // The `heif_context` holds a copy of every byte of the file, and nothing but
  // `handleMessage` will ever free it: `HeifDecoder.decode` releases only the
  // context of a previous decode on the *same* reader, and there is a fresh
  // reader per message. Left unreleased this grew by roughly 1.8x the file size
  // per decode, which is gigabytes over a folder of phone photos and ends as an
  // out-of-memory abort the user sees as "the decoder failed".
  const after = allocatorTop(api);
  assert.equal(
    after,
    before,
    `the wasm heap grew by ${after - before} bytes over 60 decodes; something is not being freed`
  );
});

test('the thumbnail path and the full decode both answer, and differ', { skip: !haveDecoder }, async () => {
  const { worker, sandbox, posted } = await loadWorker();

  await worker.handleMessage(decodeRequest(sandbox, 1, 224, true));
  await worker.handleMessage(decodeRequest(sandbox, 2, 0, false));

  const [thumb, full] = posted;
  assert.ok(thumb.ok && thumb.fromThumbnail, 'the 224 px request should take the thumbnail item');
  assert.deepEqual([thumb.width, thumb.height], [256, 192]);

  assert.ok(full.ok, 'the unlimited request should decode the primary image');
  assert.ok(!full.fromThumbnail);
  assert.deepEqual([full.width, full.height], [640, 480]);
});

test('a thumbnail-only request that cannot be served says so', { skip: !haveDecoder }, async () => {
  const { worker, sandbox, posted } = await loadWorker();

  // 4096 px is past anything the fixture carries. With `thumbnailOnly` this is
  // an answer; without it, it is a reason to decode the primary image. The grid
  // depends on both halves — the first keeps a "no" cheap, the second is what
  // stops its last resort decoding a full frame for a file that had a perfectly
  // good 256 px item all along.
  await worker.handleMessage(decodeRequest(sandbox, 1, 4096, true));
  assert.equal(posted[0].ok, false);

  await worker.handleMessage(decodeRequest(sandbox, 2, 4096, false));
  assert.ok(posted[1].ok);
  assert.deepEqual([posted[1].width, posted[1].height], [640, 480]);
});

test('copyInterleaved unpads rows when stride exceeds the row width', () => {
  // libheif aligns rows to its own stride. Copying the channel wholesale when
  // stride != width * 4 shears the image diagonally — visible, but only on
  // files whose width happens not to be aligned.
  const api = { heif_channel: { heif_channel_interleaved: 3 } };
  const width = 2;
  const height = 2;
  const stride = 12; // 8 bytes of pixels + 4 bytes of padding per row
  const data = new Uint8Array(stride * height);
  data.set([1, 2, 3, 4, 5, 6, 7, 8, 0, 0, 0, 0], 0);
  data.set([9, 10, 11, 12, 13, 14, 15, 16, 0, 0, 0, 0], stride);

  const out = copyInterleaved(api, {
    width,
    height,
    channels: [{ id: 3, stride, data, width, height }],
  });

  assert.deepEqual(Array.from(out), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
});

test('copyInterleaved ignores channels that are not the interleaved one', () => {
  const api = { heif_channel: { heif_channel_interleaved: 3 } };
  assert.equal(
    copyInterleaved(api, { width: 1, height: 1, channels: [{ id: 0, stride: 4, data: new Uint8Array(4) }] }),
    null
  );
});
