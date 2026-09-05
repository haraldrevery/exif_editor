/**
 * heic_worker.js — HEIC decoding, off the main thread.
 *
 * A worker rather than a convenience: libheif is a software HEVC decoder, and
 * a 12 MP phone photo takes on the order of a second. On the main thread that
 * is a second in which the window does not repaint, the divider does not drag
 * and the panel does not respond — for a preview the user may be arrowing
 * straight past.
 *
 * # Protocol
 *
 *   → { id, bytes: ArrayBuffer, maxEdge, thumbnailOnly }
 *   ← { id, ok: true, width, height, buffer, fromThumbnail }
 *   ← { id, ok: false, error }
 *
 * The pixel buffer is transferred in both directions. A 12 MP image is ~48 MB
 * of RGBA; copying it across the boundary twice would cost more than the
 * decode.
 *
 * `maxEdge` asks for "no smaller than this", and is what lets the embedded
 * thumbnail item be used instead of the primary image — see
 * `decodeThumbnailItem`. Omit it to force a full-resolution decode, which is
 * what the preview stage wants.
 *
 * `thumbnailOnly` makes the absence of a suitable thumbnail item an answer
 * rather than a reason to decode the primary. The grid needs that distinction:
 * it asks every large HEIC tile for its thumbnail item, and a "no" has to cost
 * a parse. Without it the question would silently become "decode this 12 MP
 * photo", for every converter-produced file in the folder.
 */

'use strict';

/**
 * Loaded on the first request, not at startup: most sessions have no HEIC.
 *
 * **Deliberately not named `libheif`.** A classic worker's top-level scope
 * *is* its global scope, and `importScripts` evaluates the bundle into that
 * same scope — where it declares a `libheif` of its own. A binding of that
 * name here collides with it, and JavaScriptCore rejects the whole script with
 * "Can't create duplicate variable: 'libheif'", which surfaces as a decode
 * that simply never works.
 */
let decoder = null;

async function ensureDecoder() {
  if (decoder) return decoder;
  // The bundled build carries its WebAssembly inside the script and exposes a
  // `libheif` global, so there is no second file to locate relative to a
  // worker URL that differs between the two shells.
  self.importScripts('../vendor/libheif/libheif-bundle.js');

  // What the global holds is a *factory*, not the API — the package's own
  // `wasm-bundle.js` entry point is one line: `require(…)()`. Using it
  // directly yields an object with no `HeifDecoder` on it and no hint as to
  // why. Awaited because an Emscripten factory may hand back a promise while
  // it compiles; this one does not, and awaiting a plain object is free.
  let api = self.libheif;
  if (typeof api === 'function') api = await api();

  if (!api || typeof api.HeifDecoder !== 'function') {
    throw new Error('the HEIC decoder loaded but exposed no HeifDecoder');
  }
  decoder = api;
  return decoder;
}

/**
 * Copies libheif's interleaved RGBA channel into a flat buffer.
 *
 * Lifted from the bundle's own `display`, including the stride case: libheif
 * pads rows to its own alignment, so `stride` is not always `width * 4` and a
 * straight `set` of the whole channel would shear the image.
 */
function copyInterleaved(api, decoded) {
  const out = new Uint8ClampedArray(decoded.width * decoded.height * 4);
  for (const channel of decoded.channels) {
    if (channel.id !== api.heif_channel.heif_channel_interleaved) continue;
    if (channel.stride === channel.width * 4) {
      out.set(channel.data);
    } else {
      const row = channel.width * 4;
      for (let y = 0; y < channel.height; y += 1) {
        out.set(channel.data.slice(y * channel.stride, y * channel.stride + row), y * row);
      }
    }
    return out;
  }
  return null;
}

/**
 * Decodes the file's own `thmb` item, when it has one big enough to be worth it.
 *
 * A HEIC carries a second, small HEVC image referenced by a `thmb` entry in the
 * container's `iref` box — typically 256×192, and around 512×384 on a phone
 * photo. Decoding *that* is the difference between roughly a kilobyte of HEVC
 * and a full 12 MP frame, and it is what the platform thumbnailers read. The
 * app used to ignore it entirely: phone photos fell back to the 160×120 EXIF
 * thumbnail ExifTool can copy out, and converter output — which has no EXIF
 * thumbnail at all — went all the way to a full-resolution decode per tile.
 *
 * # Two calling conventions, in one API
 *
 * The vendored bundle exposes these functions **twice over, differently**.
 * Where libheif's own JS layer registered an embind binding, the plain name is
 * that binding and it takes the wrapper *object*. Where it did not — which is
 * the case for every thumbnail function — the bundle's export loop aliases the
 * raw wasm export under the same plain name, and that takes an integer
 * pointer. Passing the wrong one is not a soft failure: embind throws
 * `Cannot pass "227000" as a heif_image_handle const*`, and the raw side
 * silently coerces an object to 0 and reports no thumbnails at all.
 *
 * So: `get_number_of_thumbnails`, `get_list_of_thumbnail_IDs` and
 * `get_thumbnail` are raw and take `handle.$$.ptr`; `heif_js_decode_image2`
 * and `heif_image_release` are embind and take objects.
 *
 * `heif_image_handle_get_thumbnail` returns `struct heif_error` by value. That
 * is 12 bytes, past the size wasm32 returns in registers, so the ABI passes a
 * hidden pointer for it as a **prepended** first argument.
 *
 * Returns `null` — never throws — whenever the thumbnail is missing, too small
 * to serve `maxEdge`, or anything at all looks wrong. The caller then does the
 * full decode it would have done anyway.
 */
function decodeThumbnailItem(api, wrapper, maxEdge) {
  const handlePtr = wrapper && wrapper.$$ && wrapper.$$.ptr;
  if (!handlePtr || !wrapper.$$.ptrType) return null;

  const count = api.heif_image_handle_get_number_of_thumbnails(handlePtr);
  if (!count) return null;

  let thumbPtr = 0;
  const idsPtr = api._malloc(4 * count);
  const errPtr = api._malloc(16);
  const outPtr = api._malloc(4);
  try {
    api.heif_image_handle_get_list_of_thumbnail_IDs(handlePtr, idsPtr, count);
    const itemId = api.HEAPU32[idsPtr >> 2];

    api.HEAPU32[outPtr >> 2] = 0;
    api.heif_image_handle_get_thumbnail(errPtr, handlePtr, itemId, outPtr);
    if (api.HEAP32[errPtr >> 2] !== 0) return null;
    thumbPtr = api.HEAPU32[outPtr >> 2];
    if (!thumbPtr) return null;
  } finally {
    api._free(idsPtr);
    api._free(errPtr);
    api._free(outPtr);
  }

  try {
    // The raw accessors, because `thumbPtr` is a pointer and the plain
    // `get_width`/`get_height` names are the embind bindings here.
    const width = api._heif_image_handle_get_width(thumbPtr);
    const height = api._heif_image_handle_get_height(thumbPtr);
    // Below the size actually being drawn, the primary is worth the decode:
    // upscaling a 256 px thumbnail into a 512 px tile looks worse than the
    // EXIF thumbnail this is meant to improve on.
    if (!width || !height || Math.max(width, height) < maxEdge) return null;

    // embind needs one of its own wrapper objects, and there is no exported
    // way to build one around a pointer we already hold. Constructing it off
    // the prototype is deliberate: going through the constructor would
    // register the object for finalisation, and the finaliser would release a
    // handle this function has already released by hand.
    const thumbWrapper = Object.create(wrapper.constructor.prototype);
    thumbWrapper.$$ = { ptrType: wrapper.$$.ptrType, ptr: thumbPtr, count: { value: 1 } };

    const decoded = api.heif_js_decode_image2(
      thumbWrapper,
      api.heif_colorspace.heif_colorspace_RGB,
      api.heif_chroma.heif_chroma_interleaved_RGBA
    );
    if (!decoded || decoded.code || !decoded.channels) return null;
    // If the wrapper were marshalled wrongly we could be looking at some other
    // image entirely. Cheap to rule out, and the alternative is a tile showing
    // the wrong photo.
    if (decoded.width !== width || decoded.height !== height) return null;

    try {
      const data = copyInterleaved(api, decoded);
      return data ? { width, height, data } : null;
    } finally {
      api.heif_image_release(decoded.image);
    }
  } finally {
    api._heif_image_handle_release(thumbPtr);
  }
}

async function handleMessage(event) {
  const { id, bytes, maxEdge, thumbnailOnly } = event.data || {};
  let heif = null;
  // The reader, not its context: `decode` can allocate a context and then fail,
  // and holding the reader is the only way to reach that allocation afterwards.
  let reader = null;
  let images = [];
  try {
    heif = await ensureDecoder();
    reader = new heif.HeifDecoder();
    // A HEIC is a *container*: burst shots and live photos hold several
    // images. The first is the primary one, which is what a viewer shows.
    images = reader.decode(new Uint8Array(bytes)) || [];
    if (!images.length) throw new Error('no image inside the file');
    const image = images[0];

    const width = image.get_width();
    const height = image.get_height();
    if (!width || !height) throw new Error('the image reported no dimensions');

    // The cheap path, when the caller said how big it needs the result and the
    // file carries a thumbnail item that size. Raw pointers and a hand-built
    // embind wrapper are involved, so anything unexpected falls through to the
    // full decode below rather than failing the request.
    if (maxEdge) {
      let thumb = null;
      try {
        thumb = decodeThumbnailItem(heif, image.handle, maxEdge);
      } catch (_) {
        thumb = null;
      }
      if (thumb) {
        self.postMessage(
          {
            id,
            ok: true,
            width: thumb.width,
            height: thumb.height,
            buffer: thumb.data.buffer,
            fromThumbnail: true,
          },
          [thumb.data.buffer]
        );
        return;
      }
      if (thumbnailOnly) {
        self.postMessage({ id, ok: false, error: 'no thumbnail item that size' });
        return;
      }
    }

    const data = new Uint8ClampedArray(width * height * 4);

    // `display` is asynchronous — it takes a callback, and the pixels are not
    // written until it fires. Awaiting it is not tidiness: the `finally` below
    // frees the image, and freeing it while the decode is still reading from
    // it faults inside the Emscripten heap. That surfaces as
    // "undefined is not an object (evaluating 'l.channels')" from deep in
    // libheif, which says nothing about the actual mistake.
    const out = await new Promise((resolve) => {
      image.display({ data, width, height }, resolve);
    });
    if (!out) throw new Error('the decoder could not render the image');

    self.postMessage({ id, ok: true, width, height, buffer: out.data.buffer }, [
      out.data.buffer,
    ]);
  } catch (error) {
    self.postMessage({ id, ok: false, error: String((error && error.message) || error) });
  } finally {
    // Emscripten heap, not JavaScript heap: the garbage collector cannot see
    // it, so a decode per photo across a filmstrip would grow without bound.
    //
    // Every handle, not just the primary: a burst shot or a live photo is
    // several top-level images and `decode` returns a handle for each.
    for (const handle of images) {
      try {
        if (handle && typeof handle.free === 'function') handle.free();
      } catch (_) {
        /* Older builds free with the decoder. */
      }
    }

    // **And the context, which nothing else frees.** `HeifDecoder.decode`
    // releases only the context of a *previous* `decode` on the same reader,
    // and this file builds a reader per message — so without this the parsed
    // file (a copy of every byte of it) stays in the wasm heap for the life of
    // the worker. Measured at ~1.8x the file size per decode against
    // `test/fixtures/phone.heic`, which is gigabytes over a folder of phone
    // photos and ends as an out-of-memory abort, reported to the user as the
    // decoder having failed.
    //
    // After the handles, which point into it. A reader per message rather than
    // one shared reader is deliberate: `handleMessage` awaits, so two requests
    // can be in flight at once (`MAX_INFLIGHT_PREVIEWS` is 2), and sharing a
    // reader would have the second `decode` free a context the first is still
    // reading from.
    if (heif && reader && reader.decoder) {
      try {
        heif.heif_context_free(reader.decoder);
      } catch (_) {
        /* Nothing left to do about it; the handles above are already gone. */
      }
      reader.decoder = null;
    }
  }
}

// Required directly by `test/heic_thumbnail.test.js`, which runs the real
// vendored wasm against the real fixture — the two calling conventions above
// are exactly the kind of thing that breaks silently on a decoder upgrade, and
// a unit test is the only place that gets noticed. Registering the listener
// would make the module unrequirable, so it is the branch, not the default.
//
// `handleMessage` and `ensureDecoder` are exported for the same reason: the
// wasm heap it frees is invisible from JavaScript, so nothing but a test that
// watches the allocator would notice the release going missing again.
if (typeof module === 'object' && module.exports) {
  module.exports = { decodeThumbnailItem, copyInterleaved, handleMessage, ensureDecoder };
} else {
  self.addEventListener('message', handleMessage);
}
