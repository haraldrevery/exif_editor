/**
 * preview_cache.js — one bounded cache of resolved preview URLs.
 *
 * Pure logic, no DOM. Loaded as a global in the app and required directly by
 * `test/preview_cache.test.js`, so the eviction rules are testable without a
 * running window.
 *
 * # Why this is not just a Map
 *
 * It used to be one, living inside `grid.js`. That was invisible-but-fine only
 * because every value was a ~1.7 KB EXIF thumbnail: a folder of 5000 photos
 * cost single-digit megabytes and nobody ever noticed the cache had no bound.
 *
 * The moment anything caches a *larger* preview — a filmstrip, a full-size
 * extraction — an unbounded map of data URIs is unbounded memory growth tied
 * to how far the user has scrolled. So the bound is here, and there is exactly
 * one cache rather than one per view, because two independent unbounded caches
 * is the same bug twice.
 *
 * # What "size" means
 *
 * A data URI *is* the bytes: the string is held in memory, and base64 inflates
 * by 4/3. An `asset:` or `file://` URL is a path — the pixels behind it belong
 * to the webview's own image cache, which we neither control nor should
 * duplicate. So only data URIs are charged against the byte budget, and the
 * entry-count cap is what bounds the cheap ones.
 *
 * Both caps are enforced, because either alone has a bad case: bytes alone
 * lets a million path-shaped entries accumulate for free, and count alone lets
 * a hundred full-size extractions eat a gigabyte.
 */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.ExifPreviewCache = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Entries, regardless of size. Generous: a negative result costs nothing. */
  const DEFAULT_MAX_ENTRIES = 4000;
  /** Bytes of data-URI string held. ~64 MB. */
  const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

  /**
   * Approximate bytes an entry costs us.
   *
   * Accepts either a bare URL string or a record carrying one, because the
   * grid needs to remember an extracted preview's orientation alongside its
   * URL and splitting that across two structures would mean two things to keep
   * bounded instead of one.
   *
   * `null` is a negative result — "this file has no preview" — and is the whole
   * reason scrolling past an unextractable file repeatedly does not re-run the
   * extraction. It costs a map slot and nothing else.
   */
  function sizeOf(value) {
    const url = typeof value === 'string' ? value : value && value.url;
    if (typeof url !== 'string') return 0;
    // Only a data: URI carries its payload in the string. Everything else is
    // a reference to bytes the webview holds in its own image cache, and
    // charging for those would be counting memory we do not own.
    return url.startsWith('data:') ? url.length : 0;
  }

  /**
   * @param {object} [options]
   * @param {number} [options.maxEntries]
   * @param {number} [options.maxBytes]
   * @param {(path: string, url: string|null) => void} [options.onEvict]
   *   Called for each entry as it leaves, including on `clear()`. The grid uses
   *   this to drop a stale `<img>` from a tile that is still on screen —
   *   without it, an edited photo keeps showing its pre-edit thumbnail until it
   *   happens to scroll out of view and back.
   *
   *   More than one view can share a cache, so this is a list rather than a
   *   slot: a single callback would mean whichever view was constructed second
   *   silently kept showing evicted images. `addEvictListener` adds the rest.
   */
  function createPreviewCache(options) {
    const settings = options || {};
    const maxEntries = settings.maxEntries || DEFAULT_MAX_ENTRIES;
    const maxBytes = settings.maxBytes || DEFAULT_MAX_BYTES;
    const listeners = settings.onEvict ? [settings.onEvict] : [];

    function announce(path, url) {
      // A listener throwing must not abandon the eviction half-done: the entry
      // is already out of the map and its bytes already credited back, so
      // bailing here would leave the other views showing an image the cache no
      // longer believes in.
      for (const listener of listeners) {
        try {
          listener(path, url);
        } catch (_) {
          /* A view failing to repaint is not the cache's problem. */
        }
      }
    }

    // Insertion order is the LRU order: a Map iterates oldest-first, and `get`
    // re-inserts to move an entry to the back. That is the whole eviction
    // policy, and it needs no second structure to maintain.
    const entries = new Map();
    let bytes = 0;

    function drop(path) {
      if (!entries.has(path)) return;
      const url = entries.get(path);
      entries.delete(path);
      bytes -= sizeOf(url);
      announce(path, url);
    }

    /**
     * Evicts oldest-first until both caps are met, never touching `keep`.
     *
     * `keep` is the entry just inserted, and protecting it is what stops a
     * single oversized value from evicting *itself*. Without that, storing one
     * preview bigger than the whole byte budget drops it again immediately,
     * the caller sees a cache miss, re-fetches, stores, and is dropped again —
     * a livelock that presents as one photo pinning a core forever. A cache is
     * allowed to exceed its budget by at most the one entry it was just asked
     * to hold; refusing the entry outright would look identical to a miss and
     * cause the same loop.
     */
    function evictUntilWithinBounds(keep) {
      // `entries.keys().next()` is the oldest, since a `get` hit re-inserts.
      while (entries.size > maxEntries || bytes > maxBytes) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        if (oldest.value === keep) {
          // The protected entry is the oldest, so everything else is already
          // gone and there is nothing further to give.
          if (entries.size <= 1) break;
          // Move it to the back and carry on with the rest.
          const url = entries.get(keep);
          entries.delete(keep);
          entries.set(keep, url);
          continue;
        }
        drop(oldest.value);
      }
    }

    return {
      /**
       * The cached URL, `null` for a known-absent preview, or `undefined` when
       * the path has never been resolved.
       *
       * The three-way distinction is load-bearing: `null` and `undefined` mean
       * opposite things to the caller, and collapsing them makes the app
       * re-extract every unextractable file on every scroll.
       */
      get(path) {
        if (!entries.has(path)) return undefined;
        const url = entries.get(path);
        // Re-insert to mark as recently used.
        entries.delete(path);
        entries.set(path, url);
        return url;
      },

      has(path) {
        return entries.has(path);
      },

      set(path, url) {
        if (entries.has(path)) drop(path);
        entries.set(path, url);
        bytes += sizeOf(url);
        evictUntilWithinBounds(path);
      },

      delete(path) {
        drop(path);
      },

      /**
       * Drops everything, firing `onEvict` for each.
       *
       * Called after a write: the files on disk have changed, so every cached
       * preview of them is a picture of a file that no longer exists.
       */
      clear() {
        // Snapshot the keys: `drop` mutates the map, and `onEvict` may too.
        for (const path of [...entries.keys()]) drop(path);
        bytes = 0;
      },

      /**
       * Adds another view's eviction handler.
       *
       * Returns a function that removes it again, so a view that goes away
       * does not keep being told about entries it no longer draws.
       */
      addEvictListener(listener) {
        listeners.push(listener);
        return () => {
          const at = listeners.indexOf(listener);
          if (at !== -1) listeners.splice(at, 1);
        };
      },

      /** For tests and diagnostics. */
      stats() {
        return { entries: entries.size, bytes, maxEntries, maxBytes };
      },
    };
  }

  return { createPreviewCache, sizeOf, DEFAULT_MAX_ENTRIES, DEFAULT_MAX_BYTES };
});
