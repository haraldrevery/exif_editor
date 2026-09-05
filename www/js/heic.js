/**
 * heic.js — HEIC decoding, for the preview stage and for grid tiles.
 *
 * Two quite different jobs, told apart by whether a `maxEdge` is given.
 *
 * The preview stage asks for no limit and gets a full-resolution decode of the
 * primary image: hundreds of milliseconds, for the one photo somebody is
 * actually looking at. The grid asks for a floor, and the worker then decodes
 * the file's embedded `thmb` item instead whenever there is one at least that
 * big — a kilobyte of HEVC rather than a 12 MP frame. That is what makes it
 * reasonable for the grid to call this at all; the earlier version could only
 * afford it as a last resort for files that had nothing to extract.
 *
 * **The floor is not the size the result is stored at.** They are separate
 * arguments everywhere below, and the one bug this file is most prone to is
 * passing the store size for both — see `tileThumbnail`.
 *
 * Everything here degrades to `null`. The decoder is an optional vendored
 * dependency (`build_tools/fetch_heic_decoder.py`) and the app is expected to
 * work without it — a checkout that skipped that step, or a build that chose
 * not to ship an LGPL component, still reads and writes HEIC metadata and
 * still shows extracted thumbnails. Preview simply says what it is showing.
 */

(function () {
  'use strict';

  /** A 12 MP decode is around a second; this is the pathological-file guard. */
  const DECODE_TIMEOUT_MS = 45000;

  /**
   * Quality for the JPEG the decoded pixels are re-encoded into.
   *
   * The stage displays an `<img>`, so the RGBA has to become something an
   * `<img>` can load. JPEG rather than PNG because a 12 MP PNG is ~35 MB of
   * blob against ~2 MB, and this is a preview for identifying and inspecting a
   * photo, not a rendering pipeline — nothing is ever written back from it.
   */
  const JPEG_QUALITY = 0.92;

  /** Worker crashes tolerated before the decoder is written off completely. */
  const MAX_WORKER_FAILURES = 3;

  let worker = null;
  /** Set once the decoder is known to be unusable, so it is not retried. */
  let unavailable = false;
  let failures = 0;
  let nextId = 1;
  const pending = new Map();

  /**
   * Reports why decoding is not happening, once per distinct reason.
   *
   * Every failure here degrades to the embedded thumbnail, which is right for
   * the user and useless for anyone diagnosing it: "the decoder is not
   * installed" is what the note says whether the file is missing, the worker
   * was refused, or the WebAssembly was blocked by a Content-Security-Policy.
   * Those need different fixes. This goes to the same stderr channel as the
   * renderer probe, for the same reason — it is the first thing worth knowing
   * when someone reports that HEIC previews look terrible.
   */
  const reported = new Set();

  function report(reason) {
    if (reported.has(reason)) return;
    reported.add(reason);
    try {
      window.NativeAPI.reportRenderer(`heic: ${reason}`);
    } catch (_) {
      /* Diagnostic only. */
    }
  }

  function ensureWorker() {
    if (worker || unavailable) return worker;
    try {
      worker = new Worker('js/heic_worker.js');
      worker.addEventListener('message', (event) => {
        const message = event.data || {};
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        entry.resolve(message);
      });
      worker.addEventListener('error', (event) => {
        const reason = (event && event.message) || 'the HEIC decoder failed';
        report(`worker error — ${reason}`);
        // Whatever went wrong took the worker's outstanding work with it.
        for (const [, entry] of pending) {
          clearTimeout(entry.timer);
          entry.resolve({ ok: false, error: reason });
        }
        pending.clear();
        worker = null;

        // Not permanent on the first failure. One malformed file must not
        // disable HEIC previews for the rest of the session — but a worker
        // that dies on everything should stop being asked, rather than being
        // rebuilt once per photo for as long as the user keeps arrowing.
        failures += 1;
        if (failures >= MAX_WORKER_FAILURES) {
          unavailable = true;
          report('giving up on the decoder after repeated failures');
        }
      });
    } catch (error) {
      // Worker construction is refused outright on some origins. Not fatal:
      // the caller falls back to the extracted thumbnail.
      unavailable = true;
      worker = null;
      report(`cannot start the worker — ${(error && error.message) || error}`);
    }
    return worker;
  }

  function ask(bytes, maxEdge, thumbnailOnly) {
    const active = ensureWorker();
    if (!active) return Promise.resolve({ ok: false, error: 'no decoder' });
    return new Promise((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ ok: false, error: 'the decoder did not answer in time' });
      }, DECODE_TIMEOUT_MS);
      pending.set(id, { resolve, timer });
      // Transferred, not copied: this is the whole file.
      active.postMessage({ id, bytes, maxEdge, thumbnailOnly }, [bytes]);
    });
  }

  function base64ToBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  function drawToCanvas(width, height, buffer) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.putImageData(new ImageData(new Uint8ClampedArray(buffer), width, height), 0, 0);
    return canvas;
  }

  function encodeToBlobUrl(width, height, buffer) {
    return new Promise((resolve) => {
      const canvas = drawToCanvas(width, height, buffer);
      if (!canvas) {
        resolve(null);
        return;
      }
      canvas.toBlob(
        (blob) => resolve(blob ? URL.createObjectURL(blob) : null),
        'image/jpeg',
        JPEG_QUALITY
      );
    });
  }

  /**
   * Downscales the decoded pixels and returns them as a **data URI**.
   *
   * A data URI rather than a blob URL, for two reasons that both bite in the
   * grid specifically. The preview cache charges only `data:` entries against
   * its byte budget, so a blob would hold real memory while the cache
   * accounted it free and never evicted for it; and an evicted blob URL is
   * never revoked, so scrolling a folder of these would leak a decoded
   * thumbnail per file. At tile sizes the JPEG is 10–20 KB, which the existing
   * budget handles correctly.
   */
  function encodeToThumbnailUri(width, height, buffer, maxEdge) {
    return new Promise((resolve) => {
      const full = drawToCanvas(width, height, buffer);
      if (!full) {
        resolve(null);
        return;
      }
      const scale = Math.min(1, maxEdge / Math.max(width, height));
      if (scale === 1) {
        resolve(full.toDataURL('image/jpeg', JPEG_QUALITY));
        return;
      }
      const small = document.createElement('canvas');
      small.width = Math.max(1, Math.round(width * scale));
      small.height = Math.max(1, Math.round(height * scale));
      const context = small.getContext('2d');
      if (!context) {
        resolve(null);
        return;
      }
      context.imageSmoothingQuality = 'high';
      context.drawImage(full, 0, 0, small.width, small.height);
      resolve(small.toDataURL('image/jpeg', JPEG_QUALITY));
    });
  }

  /**
   * Decodes `path` to an object URL the stage can display.
   *
   * Resolves to `null` for every failure — no decoder installed, a file that is
   * not really HEIC, a decode that fell over. The caller has a working
   * fallback and does not need to distinguish them.
   *
   * **The caller owns the returned URL** and must revoke it, or a filmstrip
   * walked end to end leaks a decoded photo per step.
   */
  async function decode(path, maxEdge, thumbnailOnly) {
    if (unavailable) return null;
    let buffer = null;
    try {
      const base64 = await window.NativeAPI.readFileBytes(path);
      if (!base64) return null;
      buffer = base64ToBuffer(base64);
    } catch (error) {
      report(`cannot read the file — ${(error && error.message) || error}`);
      return null;
    }

    const result = await ask(buffer, maxEdge, thumbnailOnly);
    if (!result || !result.ok) {
      // "This file has no thumbnail item" is an ordinary answer to an ordinary
      // question, not a decoder problem. Reporting it would fill the log with
      // one line per converter-produced file in the folder.
      if (!thumbnailOnly) report(`decode failed — ${(result && result.error) || 'no answer'}`);
      return null;
    }
    return result;
  }

  async function decodeToUrl(path) {
    const result = await decode(path);
    if (!result) return null;
    try {
      const url = await encodeToBlobUrl(result.width, result.height, result.buffer);
      if (!url) report('the decoded pixels could not be encoded for display');
      return url;
    } catch (error) {
      report(`encoding for display failed — ${(error && error.message) || error}`);
      return null;
    }
  }

  /**
   * Decodes `path` to a small data URI for a grid tile, or `null`.
   *
   * `maxEdge` is passed down to the worker rather than only being applied to
   * the result, because it decides *what gets decoded*: a file whose thumbnail
   * item is at least this big never decodes its primary image at all. That is
   * the difference between about a kilobyte of HEVC and a full 12 MP frame,
   * and it is what makes this affordable to call for a whole folder rather
   * than only for files that had nothing to extract.
   */
  async function toThumbnailUri(decoded, maxEdge) {
    if (!decoded) return null;
    try {
      return await encodeToThumbnailUri(decoded.width, decoded.height, decoded.buffer, maxEdge);
    } catch (error) {
      report(`thumbnail encoding failed — ${(error && error.message) || error}`);
      return null;
    }
  }

  const DATA_URI_PREFIX = 'data:image/jpeg;base64,';

  /**
   * The thumbnail this photo produced on some earlier run, if any.
   *
   * Every failure is a miss. The cache is an optimisation over work the caller
   * is about to do anyway, so there is nothing here worth interrupting a tile
   * for — and a shell without the commands (the `web` stub) simply always
   * misses.
   */
  async function cached(path, edge) {
    try {
      const base64 = await window.NativeAPI.readThumbCache(path, edge);
      return base64 ? `${DATA_URI_PREFIX}${base64}` : null;
    } catch (_) {
      return null;
    }
  }

  /** Stores a freshly decoded thumbnail, best-effort. */
  async function remember(path, edge, uri) {
    if (!uri || !uri.startsWith(DATA_URI_PREFIX)) return;
    try {
      await window.NativeAPI.writeThumbCache(path, edge, uri.slice(DATA_URI_PREFIX.length));
    } catch (_) {
      /* A cache that cannot be written is still a working app. */
    }
  }

  /**
   * Files already known to carry no thumbnail item worth using.
   *
   * Answering that question costs a whole-file read — libheif has to parse the
   * container, so the bytes have to cross into the worker before anything can
   * say "there is nothing here". The disk cache only remembers successes, so
   * without this a folder of converter-produced HEICs would re-read every file
   * in full on every scroll past it, for ever, to be told "no" each time.
   *
   * Keyed by path and *floor*, because the floor is what decides the answer —
   * "no item of at least 224 px" says nothing about a request for 160. Not
   * persisted: it is cheap to rebuild, and an edited file must not inherit the
   * old answer.
   */
  const noThumbnailItem = new Set();

  /** The edge assumed when a caller does not name one. */
  const DEFAULT_THUMBNAIL_EDGE = 256;

  /**
   * A tile-sized thumbnail for `path`, cached, or `null`.
   *
   * Three numbers, and conflating any two of them is a bug that looks like
   * slowness rather than like breakage:
   *
   *   * `maxEdge` is what the result is **stored at** — the cache key, and the
   *     ceiling the pixels are downscaled to.
   *   * `minEdge` is the smallest thumbnail item still **worth taking** instead
   *     of decoding the primary image. Passing `maxEdge` here instead is what
   *     makes a file with a perfectly good 256 or 320 px `thmb` item decode its
   *     full 12 MP frame anyway, for failing to fill a 512 px budget it was
   *     never going to fill. The encoder never scales up, so an item between
   *     the two is kept at its own size.
   *   * `thumbnailOnly` decides what "no item that big" **means**: an answer
   *     (`null`, at the cost of a container parse), or a reason to decode the
   *     primary image.
   */
  async function tileThumbnail(path, maxEdge, minEdge, thumbnailOnly) {
    const edge = maxEdge || DEFAULT_THUMBNAIL_EDGE;
    const floor = minEdge || edge;
    const hit = await cached(path, edge);
    if (hit) return hit;

    const marker = `${floor} ${path}`;
    // Only meaningful for the question that can be answered "no". A full
    // decode has no such shortcut, and must not take one: it would turn "this
    // file has no thumbnail item" into "this file has no preview".
    if (thumbnailOnly && noThumbnailItem.has(marker)) return null;

    const uri = await toThumbnailUri(await decode(path, floor, thumbnailOnly), edge);
    if (!uri) {
      if (thumbnailOnly) noThumbnailItem.add(marker);
      return null;
    }
    await remember(path, edge, uri);
    return uri;
  }

  /**
   * A thumbnail for `path` by whatever route works, decoding the primary image
   * if that is what it takes.
   *
   * The expensive one, and the grid's last resort. It still prefers the
   * container's own thumbnail item — `minEdge` is what lets it, and leaving it
   * out is the difference between about a kilobyte of HEVC and a full frame.
   */
  function decodeToThumbnail(path, maxEdge, minEdge) {
    return tileThumbnail(path, maxEdge, minEdge, false);
  }

  /**
   * The container's own thumbnail item, or `null` if it has none that big.
   *
   * Distinct from `decodeToThumbnail` only in what "no" means. This one answers
   * the question asked; that one treats a missing thumbnail item as a reason to
   * decode the primary image instead. The grid asks this of HEIC tiles ahead of
   * everything else, so the difference is a folder that draws in milliseconds
   * against one that decodes every converter-produced file at full resolution.
   */
  function decodeEmbeddedThumbnail(path, maxEdge, minEdge) {
    return tileThumbnail(path, maxEdge, minEdge, true);
  }

  /**
   * Forgets what is known about `path`, or about everything.
   *
   * Called after a write: the file on disk is not the file that was asked
   * about. The disk cache invalidates itself through the modification time in
   * its key, but the in-memory negatives above have no such thing.
   */
  function forget(path) {
    if (!path) {
      noThumbnailItem.clear();
      return;
    }
    for (const marker of noThumbnailItem) {
      if (marker.endsWith(` ${path}`)) noThumbnailItem.delete(marker);
    }
  }

  window.ExifHeic = {
    decodeToUrl,
    decodeToThumbnail,
    decodeEmbeddedThumbnail,
    forget,
    /** Whether a decoder is known to be missing, for the preview's wording. */
    isUnavailable: () => unavailable,
  };
})();
