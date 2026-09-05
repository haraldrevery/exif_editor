/**
 * grid.js — virtualised thumbnail grid.
 *
 * Only the rows inside (and just outside) the viewport exist in the DOM. A
 * folder of a few thousand photos is ordinary, and building a tile per file
 * would stall the window on open and again on every scroll.
 *
 * Previews are loaded lazily and only for what is on screen. For JPEG/PNG/WebP
 * the webview decodes the file directly over asset:; for HEIC and TIFF — which
 * no browser engine decodes — ExifTool extracts the embedded preview, which is
 * a byte copy rather than a decode and so is fast enough to do on demand.
 *
 * # Three things here are load-bearing and easy to undo by accident
 *
 * **A resolved preview is painted synchronously.** Once a path's URL is known,
 * rebuilding its tile sets `<img src>` directly. The load/error probing in
 * `tryDisplay` exists to discover *whether a route works at all*, and it must
 * run once per path, not once per mount — re-running it turns every reflow
 * into a storm of image decodes. This is why the grid can be relaid out
 * continuously (a divider drag) without melting.
 *
 * **Resize relays out; it does not remount.** `relayout()` repositions the
 * tiles that are already mounted. `remount()` throws them away, and is only
 * correct when the *entry list* changed.
 *
 * **Extractions are queued, capped, and dropped when they go off screen.** The
 * ExifTool session is a single serialised process shared with metadata reads,
 * so an unbounded burst of preview requests does not just waste work — it
 * head-of-line blocks the side panel behind a queue the user cannot see.
 */

(function () {
  'use strict';

  /**
   * The sizes a tile may be, smallest first.
   *
   * Discrete rather than continuous: each step is a size the column arithmetic
   * and the quarter-turn fit are both known to be right at, and stepping
   * between four values is easier to aim than nudging a number. 168 is the
   * middle one and the default, so an existing user's grid does not move.
   */
  const TILE_SIZES = [120, 168, 224, 288];
  const DEFAULT_TILE_SIZE = 168;
  const GAP = 12;
  /** Rows rendered beyond the viewport, so scrolling does not flash blanks. */
  const OVERSCAN_ROWS = 2;

  /**
   * Extractions allowed to be outstanding at once.
   *
   * The engine serialises them anyway (one ExifTool process, one `-execute` at
   * a time), so a higher number buys no throughput — it only lengthens the
   * queue that the panel's `read_metadata` has to wait behind. Two rather than
   * one so a slow file does not leave the engine idle between requests.
   */
  const MAX_INFLIGHT_PREVIEWS = 2;

  /**
   * How long to wait for an `<img>` to say whether it decoded.
   *
   * A webview that fires neither `load` nor `error` — malformed data URI,
   * decoder giving up quietly — would otherwise leave the promise pending
   * forever, and with it a permanently occupied slot in `inFlight`. The whole
   * queue would then drain to a halt with no error anywhere.
   */
  const DISPLAY_TIMEOUT_MS = 15000;

  /**
   * Longest edge of a decoded HEIC thumbnail.
   *
   * Comfortably above the largest tile (288px) so stepping the grid up does
   * not turn every cached thumbnail soft, and small enough that the JPEG stays
   * in the tens of kilobytes the preview cache is budgeted for.
   */
  const THUMBNAIL_DECODE_EDGE = 512;

  /**
   * Tile size at which the extracted EXIF thumbnail stops being good enough.
   *
   * That thumbnail is 160x120 — measured, not assumed; it is what every phone
   * writes and what `test/fixtures/phone.heic` carries. Drawn into a 120 or
   * 168 px tile it is fine. Drawn into a 224 or 288 px one, or into any tile on
   * a 2x display, it is being upscaled several times over and looks it, while
   * the file has a far better thumbnail sitting unused inside it.
   *
   * Below this the byte copy wins and nothing decodes; at or above it, HEIC
   * tiles try the container's own `thmb` item first.
   */
  const SHARP_TILE_MIN = 224;

  /** Whether a name claims to be HEIC. Only decides what to try, never truth. */
  function isHeicName(name) {
    return /\.hei[cf]$/i.test(String(name || ''));
  }

  function createGrid({ scroller, sizer, onSelect, onActivate }) {
    let entries = [];
    let selected = new Set();
    /** Paths holding edits the user has typed but not applied. */
    let drafted = new Set();
    let columns = 1;
    /** Tile edge in px. Square, so one number covers both axes. */
    let tileSize = DEFAULT_TILE_SIZE;
    /**
     * Set when the tile geometry changed, cleared once a real tile has been
     * measured. Guards `refreshQuarterTurnFit` so the forced layout it costs
     * happens once per size change rather than once per animation frame.
     */
    let fitNeedsMeasuring = true;
    /** path -> tile element, for the tiles currently mounted. */
    const mounted = new Map();
    let rafHandle = null;

    /**
     * path -> resolved preview, once known.
     *
     * `{ url, orientation }` when there is one, `null` when the file genuinely
     * has none, `undefined` when it has never been looked at. Those last two
     * are different answers and collapsing them makes the app re-run an
     * extraction that is known to come back empty, on every scroll, forever.
     *
     * Exposed on the returned object so a second view of the same photos can
     * share it rather than building a second unbounded copy of the same pixels.
     */
    const previews = window.ExifPreviewCache.createPreviewCache({
      onEvict: (path) => forgetTileImage(path),
    });

    /** Entries waiting for an extraction slot, and the paths that dedupe them. */
    const queue = [];
    const queued = new Set();
    /** Paths currently being resolved. */
    const inFlight = new Set();

    /* ── Layout ───────────────────────────────────────────────────────────── */

    /** Recomputes the column count and the scroll height. */
    function layout() {
      const available = scroller.clientWidth - 2 * GAP;
      columns = Math.max(1, Math.floor((available + GAP) / (tileSize + GAP)));
      const rows = Math.ceil(entries.length / columns);
      sizer.style.height = `${Math.max(0, rows * (tileSize + GAP) - GAP)}px`;
    }

    function visibleRange() {
      const rowHeight = tileSize + GAP;
      const first = Math.max(0, Math.floor(scroller.scrollTop / rowHeight) - OVERSCAN_ROWS);
      const visibleRows = Math.ceil(scroller.clientHeight / rowHeight) + 2 * OVERSCAN_ROWS;
      const start = first * columns;
      const end = Math.min(entries.length, (first + visibleRows) * columns);
      return { start, end };
    }

    function position(tile, index) {
      const row = Math.floor(index / columns);
      const column = index % columns;
      tile.style.transform =
        `translate(${column * (tileSize + GAP)}px, ${row * (tileSize + GAP)}px)`;
    }

    /* ── Tiles ────────────────────────────────────────────────────────────── */

    /**
     * An `<img>` for an already-resolved preview.
     *
     * Synchronous on purpose: no promise, no load handler, no re-probing. The
     * URL is known to work because it was probed when it was first resolved.
     */
    function buildImage(record) {
      const img = document.createElement('img');
      img.decoding = 'async';
      img.alt = '';
      // `orientation` is 0 for anything decoded directly: the file carries its
      // own rotation and the webview has already applied it, so the attribute
      // stays off and the stylesheet leaves the image alone.
      //
      // An extracted preview is a bare JPEG blob whose rotation lives in the
      // *parent* file, and gets the attribute even when the value is 1 —
      // that is what scopes `image-orientation: none` to exactly these images,
      // so a blob carrying a stray orientation of its own cannot be applied on
      // top of the parent's.
      if (record.orientation >= 1) img.dataset.orient = String(record.orientation);
      img.src = record.url;
      return img;
    }

    function buildTile(entry, index) {
      const tile = document.createElement('div');
      tile.className = 'tile';
      tile.dataset.path = entry.path;
      tile.style.width = `${tileSize}px`;
      tile.style.height = `${tileSize}px`;

      const imageWrap = document.createElement('div');
      imageWrap.className = 'tile-image';

      const cached = previews.get(entry.path);
      if (cached) {
        imageWrap.appendChild(buildImage(cached));
      } else {
        const placeholder = document.createElement('div');
        placeholder.className = 'tile-placeholder';
        // Blank while loading: an empty tile that fills in reads as calm, where
        // a grid of "Loading…" labels flickering to images reads as busy. A
        // file known to have no preview says so, because that one is final.
        placeholder.textContent = cached === null ? 'No preview' : '';
        imageWrap.appendChild(placeholder);
      }

      const name = document.createElement('div');
      name.className = 'tile-name';
      name.textContent = entry.name;
      name.title = entry.name;

      const badges = document.createElement('div');
      badges.className = 'tile-badges';
      if (drafted.has(entry.path)) badges.appendChild(buildDraftBadge());

      tile.append(imageWrap, name, badges);

      tile.addEventListener('click', (event) => {
        onSelect(entry.path, {
          toggle: event.ctrlKey || event.metaKey,
          range: event.shiftKey,
        });
      });
      tile.addEventListener('dblclick', () => onActivate && onActivate(entry.path));

      position(tile, index);
      return tile;
    }

    /**
     * The mark on a tile whose photo holds unapplied edits.
     *
     * The whole point of keeping drafts across a selection change is that they
     * are findable afterwards; without something on the tile, an edit typed by
     * accident and left behind is invisible until Apply is pressed on it.
     */
    function buildDraftBadge() {
      const badge = document.createElement('div');
      badge.className = 'badge draft';
      badge.title = 'Unsaved metadata edits';
      // A dot, not a glyph: at 120px tiles there is no room for a letter, and
      // the icon set has nothing that means "unsaved".
      badge.textContent = '';
      return badge;
    }

    function setNote(path, text) {
      const tile = mounted.get(path);
      const note = tile && tile.querySelector('.tile-placeholder');
      if (note) note.textContent = text;
    }

    /**
     * Returns a mounted tile to its unresolved state.
     *
     * Called when an entry leaves the cache. Without this the tile keeps
     * showing the image it already has — so after an edit, the photo on screen
     * is the one from before the write, and stays that way until it happens to
     * scroll out of view and back.
     */
    function forgetTileImage(path) {
      const tile = mounted.get(path);
      if (!tile) return;
      const wrap = tile.querySelector('.tile-image');
      if (!wrap) return;
      const placeholder = document.createElement('div');
      placeholder.className = 'tile-placeholder';
      placeholder.textContent = '';
      wrap.replaceChildren(placeholder);
      // The next render sees a cache miss and queues it again.
      schedule();
    }

    /* ── Resolving a preview ──────────────────────────────────────────────── */

    /**
     * Resolves to whether this webview can actually display `record`, and
     * paints it into the tile if it can and the tile is still there.
     *
     * The `<img>` error event is the only honest test of whether this webview
     * can display a given file — extensions lie, and MIME sniffing in the
     * shell would just be guessing a second time.
     *
     * **Whether the tile is still mounted is deliberately not part of the
     * answer.** Conflating "this route does not work" with "the user scrolled
     * away while we were asking" is how a perfectly good photo ends up cached
     * as a *negative* — permanently captioned "No preview" for the rest of the
     * session, because a scroll happened to outrun a decode. The probe always
     * runs to completion; only the painting is conditional.
     */
    function probeAndPaint(path, record) {
      return new Promise((resolve) => {
        const img = buildImage(record);
        let settled = false;
        const finish = (ok) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(ok);
        };
        // Neither event firing must not strand the queue slot. See
        // DISPLAY_TIMEOUT_MS.
        const timer = setTimeout(() => finish(false), DISPLAY_TIMEOUT_MS);
        img.addEventListener('load', () => {
          // The tile may have scrolled away while the image was decoding. That
          // costs us the paint, not the result.
          const live = mounted.get(path);
          const target = live && live.querySelector('.tile-image');
          if (target) target.replaceChildren(img);
          finish(true);
        });
        img.addEventListener('error', () => finish(false));
      });
    }

    function directRoute(path) {
      const url = window.NativeAPI.imageUrl(path);
      // The webview reads orientation out of the file itself for anything it
      // decodes directly, so overriding it here would rotate twice.
      return url ? { url, orientation: 0 } : null;
    }

    /**
     * The HEIC container's own thumbnail item, decoded.
     *
     * Worth trying ahead of extraction only when the tile is large enough that
     * a 160x120 EXIF thumbnail visibly suffers — see SHARP_TILE_MIN. Returns
     * `null` whenever the file has no thumbnail item big enough, which sends
     * the caller back to the ordinary routes rather than to a full-resolution
     * decode; the expensive fallback stays where it was, at the very end.
     */
    async function thumbnailItemRoute(path) {
      if (!window.ExifHeic) return null;
      const url = await window.ExifHeic.decodeEmbeddedThumbnail(
        path,
        THUMBNAIL_DECODE_EDGE,
        // The bar is the image this replaces, not the tile it fills. A 160x120
        // EXIF thumbnail is what the alternative route returns, so any item
        // that serves the tile size which made it insufficient is an
        // improvement — and asking for the full 512 instead would decline the
        // 256 and 320 px items that are common, then fall back to the 160x120
        // anyway, having already paid for the read.
        SHARP_TILE_MIN
      );
      // A data URI, so the cache's byte budget accounts for it and nothing
      // needs revoking when it is evicted. See heic.js.
      return url ? { url, orientation: 0 } : null;
    }

    /** Whether tiles are currently big enough to want a sharper source. */
    function wantsSharpThumbnails() {
      return tileSize >= SHARP_TILE_MIN || (window.devicePixelRatio || 1) >= 2;
    }

    async function extractRoute(path) {
      const preview = await window.NativeAPI.readPreview(path);
      if (!preview || !preview.base64) return null;
      return {
        url: `data:image/jpeg;base64,${preview.base64}`,
        // An extracted blob carries no orientation of its own; what applies to
        // it is the parent file's, which the core reads in the same round trip.
        orientation: preview.orientation || 1,
      };
    }

    /**
     * Resolves a tile's image, trying both routes in whichever order is more
     * likely to succeed, and falling back to the other.
     *
     * Neither route can be trusted on its own:
     *   * The extension is a claim, not a fact — a JPEG saved as `.heic`
     *     decodes directly but has nothing to extract, and a real HEIC is the
     *     other way round.
     *   * A file can legitimately have no embedded preview at all.
     *
     * So `needsPreview` only decides which to attempt *first*; both are tried
     * before giving up.
     *
     * A HEIC at a large tile size gets a third route ahead of both, reading the
     * thumbnail the container already carries rather than the 160x120 one the
     * EXIF block carries. It declines cheaply when the file has nothing better,
     * so the cost of asking is a parse, not a decode.
     */
    async function resolvePreview(entry) {
      const path = entry.path;
      inFlight.add(path);
      try {
        const routes = entry.needsPreview
          ? [extractRoute, async (p) => directRoute(p)]
          : [async (p) => directRoute(p), extractRoute];
        if (isHeicName(entry.name) && wantsSharpThumbnails()) {
          routes.unshift(thumbnailItemRoute);
        }

        for (const route of routes) {
          let record = null;
          try {
            record = await route(path);
          } catch (error) {
            // An extraction failure is not fatal — the other route may work.
            continue;
          }
          if (!record) continue;
          if (await probeAndPaint(path, record)) {
            previews.set(path, record);
            return;
          }
        }
        // Last resort, and only for HEIC. Extraction found nothing, which for
        // this format means the file came out of a converter: its only
        // thumbnail is another HEVC image item, not a JPEG anyone can hand
        // back. Decoding is expensive — hundreds of milliseconds of software
        // HEVC against a byte copy — so it runs *here*, after both cheap routes
        // have failed, rather than for every HEIC in the folder. A phone photo
        // never reaches this line.
        if (isHeicName(entry.name) && window.ExifHeic) {
          setNote(path, 'Decoding…');
          let url = null;
          try {
            url = await window.ExifHeic.decodeToThumbnail(path, THUMBNAIL_DECODE_EDGE);
          } catch (error) {
            url = null;
          }
          // A data URI, so the cache's byte budget accounts for it and nothing
          // needs revoking when it is evicted. See heic.js.
          if (url && (await probeAndPaint(path, { url, orientation: 0 }))) {
            previews.set(path, { url, orientation: 0 });
            return;
          }
        }

        // Cached as a negative so scrolling past it repeatedly does not
        // re-run an extraction that is known to come back empty.
        previews.set(path, null);
        setNote(path, 'No preview');
      } finally {
        inFlight.delete(path);
        pump();
      }
    }

    /**
     * Starts as much queued work as the concurrency cap allows.
     *
     * Requests are dropped rather than issued when their tile has scrolled
     * away. An in-flight ExifTool call cannot be cancelled, so this is the only
     * point at which work for a photo nobody is looking at can be abandoned —
     * and it is what keeps a fast scroll through a HEIC folder from queueing
     * hundreds of extractions ahead of the panel's next metadata read.
     */
    function pump() {
      while (inFlight.size < MAX_INFLIGHT_PREVIEWS && queue.length) {
        const entry = queue.shift();
        queued.delete(entry.path);
        // The three reasons to drop it: nobody is looking at it any more, it
        // is already being fetched, or it was resolved while it sat in the
        // queue.
        if (!mounted.has(entry.path)) continue;
        if (inFlight.has(entry.path)) continue;
        if (previews.has(entry.path)) continue;
        resolvePreview(entry);
      }
    }

    function enqueue(entry) {
      const path = entry.path;
      if (queued.has(path) || inFlight.has(path) || previews.has(path)) return;
      queued.add(path);
      queue.push(entry);
    }

    /* ── Rendering ────────────────────────────────────────────────────────── */

    function render() {
      rafHandle = null;
      const { start, end } = visibleRange();
      const wanted = new Set();

      for (let i = start; i < end; i += 1) {
        const entry = entries[i];
        if (!entry) continue;
        wanted.add(entry.path);

        let tile = mounted.get(entry.path);
        if (!tile) {
          tile = buildTile(entry, i);
          // Mount before queueing: `pump` looks the tile up by path so it can
          // drop work for a tile that has since been unmounted.
          mounted.set(entry.path, tile);
          sizer.appendChild(tile);
        } else {
          position(tile, i);
        }
        // Cheap and idempotent: skipped outright for anything already resolved
        // or already in the queue.
        enqueue(entry);
        tile.classList.toggle('selected', selected.has(entry.path));
      }

      // Unmount what scrolled away. The preview cache survives, so scrolling
      // back is instant and never re-runs an extraction.
      for (const [path, tile] of mounted) {
        if (!wanted.has(path)) {
          tile.remove();
          mounted.delete(path);
        }
      }

      if (fitNeedsMeasuring && mounted.size) {
        fitNeedsMeasuring = false;
        refreshQuarterTurnFit();
      }

      pump();
    }

    function schedule() {
      if (rafHandle !== null) return;
      rafHandle = requestAnimationFrame(render);
    }

    /**
     * Refreshes the scale a quarter-turned thumbnail is drawn at.
     *
     * A rotated image fitted to the tile's image box no longer fits it once
     * turned 90°, because that box is wider than it is tall — the name row
     * takes height and does not scale with the tile. Scaling by the box's
     * short/long ratio guarantees the turned image lands inside it whatever
     * its aspect.
     *
     * **Measured rather than tabulated.** The ratio moves with tile size (0.80
     * at 120px against 0.92 at 288px) because the name row's height is fixed
     * by its font, not by the tile. A table of per-size constants would be a
     * second place for the tile geometry to live, and would silently go wrong
     * the first time the type scale changed. One read of a real tile per size
     * change cannot drift from the CSS.
     */
    function refreshQuarterTurnFit() {
      const sample = mounted.values().next().value;
      const box = sample && sample.querySelector('.tile-image');
      if (!box) return;
      const width = box.clientWidth;
      const height = box.clientHeight;
      if (!width || !height) return;
      scroller.style.setProperty(
        '--quarter-turn-fit',
        String(Math.min(width, height) / Math.max(width, height))
      );
    }

    /**
     * Reflows without discarding anything.
     *
     * This is what a resize needs — a window drag, or a divider being dragged
     * continuously. The tiles keep their images; only their positions change,
     * and when the column count has not changed even that is a no-op.
     */
    function relayout() {
      const before = columns;
      layout();
      if (columns === before) return;
      schedule();
    }

    /** Throws every tile away. Only correct when the entry list changed. */
    function remount() {
      unmountAll();
      layout();
      schedule();
    }

    /**
     * Settles on a tile size and rebuilds at it.
     *
     * A declared function rather than a method on the returned object, so it
     * can be called from `stepTileSize` without `this` — which would break the
     * moment anything destructured the grid's API.
     */
    function applyTileSize(size) {
      const next = TILE_SIZES.includes(size) ? size : DEFAULT_TILE_SIZE;
      if (next === tileSize) return tileSize;
      tileSize = next;
      fitNeedsMeasuring = true;
      // A full remount rather than a relayout: each tile's width and height are
      // inline styles set at build time. Cheap now — a resolved preview is
      // painted straight from the cache rather than decoded again.
      remount();
      return tileSize;
    }

    function unmountAll() {
      for (const tile of mounted.values()) tile.remove();
      mounted.clear();
      // Anything queued belongs to a tile that no longer exists.
      queue.length = 0;
      queued.clear();
    }

    scroller.addEventListener('scroll', schedule, { passive: true });
    // ResizeObserver rather than window.resize: the grid also reflows when the
    // side panel changes width, which never fires a window event.
    new ResizeObserver(() => relayout()).observe(scroller);

    return {
      setEntries(next) {
        entries = next;
        // Tiles are keyed by path, and a path that survives a refilter would
        // otherwise keep a stale grid position.
        remount();
      },
      setSelection(paths) {
        selected = new Set(paths);
        for (const [path, tile] of mounted) {
          tile.classList.toggle('selected', selected.has(path));
        }
      },
      /**
       * Marks which photos hold unapplied edits.
       *
       * Updates the mounted tiles in place rather than remounting: this is
       * called on every keystroke in the panel, and rebuilding the visible
       * grid that often would undo the work that made resizing smooth.
       */
      setDraftPaths(paths) {
        drafted = new Set(paths);
        for (const [path, tile] of mounted) {
          const badges = tile.querySelector('.tile-badges');
          if (!badges) continue;
          const existing = badges.querySelector('.badge.draft');
          const wanted = drafted.has(path);
          if (wanted && !existing) badges.appendChild(buildDraftBadge());
          else if (!wanted && existing) existing.remove();
        }
      },
      /**
       * Steps the tile size. `delta` is +1 or -1 over TILE_SIZES.
       *
       * Returns the size settled on, so the caller can update its buttons
       * without keeping its own copy of the range.
       */
      stepTileSize(delta) {
        const at = TILE_SIZES.indexOf(tileSize);
        const next = TILE_SIZES[Math.min(TILE_SIZES.length - 1, Math.max(0, at + delta))];
        return applyTileSize(next);
      },
      setTileSize: applyTileSize,
      tileSize: () => tileSize,
      tileSizes: () => TILE_SIZES.slice(),
      scrollToPath(path) {
        const index = entries.findIndex((e) => e.path === path);
        if (index === -1) return;
        const row = Math.floor(index / columns);
        scroller.scrollTop = row * (tileSize + GAP);
        schedule();
      },
      /**
       * Drops every tile without touching the cache.
       *
       * For handing the main area over to preview mode: the DOM cost goes away
       * and coming back is a paint, because every resolved preview is still
       * cached and is painted synchronously.
       */
      unmountAll,
      remount,
      clearPreviewCache() {
        // Eviction resets any tile still on screen, so an edited photo
        // re-resolves rather than continuing to show its pre-edit thumbnail.
        previews.clear();
      },
      /** The shared cache, so a second view does not build its own. */
      cache: previews,
    };
  }

  window.ExifGrid = { createGrid };
})();
