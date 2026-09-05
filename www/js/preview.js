/**
 * preview.js — full preview mode: one photo large, with a filmstrip.
 *
 * A mode of the main area rather than an overlay. The editor panel and the
 * divider stay live throughout, so metadata is still editable while looking at
 * the photo — which is the point, in an app whose whole purpose is editing
 * metadata. An overlay would have meant leaving the photo to change anything
 * about it.
 *
 * # What this deliberately does not do
 *
 * **It does not own the selection.** Arrow keys call back into the app's
 * existing `handleSelect`, so the panel, the map and the tools tab all follow
 * along without knowing preview mode exists. A private "current photo" here
 * would be a second source of truth about which file is being edited, and the
 * two would drift the moment anything else changed the selection.
 *
 * **It does not keep its own preview cache.** The filmstrip and the grid draw
 * the same photos; they share one bounded cache, and both register for
 * eviction so neither is left showing an image the cache has dropped.
 */

(function () {
  'use strict';

  /** Filmstrip tile size. Square, so portrait and landscape sit on one line. */
  const THUMB = 84;
  const THUMB_GAP = 8;
  /** Columns rendered beyond the strip's edges, so scrolling does not flash. */
  const OVERSCAN = 3;
  /** Same reasoning as the grid: the engine serialises these anyway. */
  const MAX_INFLIGHT_PREVIEWS = 2;
  const DISPLAY_TIMEOUT_MS = 15000;

  const MIN_SCALE = 0.05;
  const MAX_SCALE = 16;
  /** One notch of the wheel, or one press of + / -. */
  const ZOOM_STEP = 1.15;

  /**
   * CSS transform for an EXIF orientation, and whether it swaps the axes.
   *
   * Only ever applied to an *extracted* preview. Anything the webview decodes
   * itself has already been rotated by the time `naturalWidth` is readable, so
   * applying this on top would turn it twice.
   */
  const ORIENTATION = {
    1: { transform: '', swaps: false },
    2: { transform: 'scaleX(-1)', swaps: false },
    3: { transform: 'rotate(180deg)', swaps: false },
    4: { transform: 'scaleY(-1)', swaps: false },
    5: { transform: 'rotate(90deg) scaleX(-1)', swaps: true },
    6: { transform: 'rotate(90deg)', swaps: true },
    7: { transform: 'rotate(270deg) scaleX(-1)', swaps: true },
    8: { transform: 'rotate(270deg)', swaps: true },
  };

  function orientationOf(value) {
    return ORIENTATION[value] || ORIENTATION[1];
  }

  /**
   * Whether this name claims to be HEIC.
   *
   * The extension is only a claim — the grid has a whole fallback path for
   * exactly that reason — but here it is only deciding *what to try first*,
   * and a failed decode falls through to extraction anyway.
   */
  function isHeic(name) {
    return /\.hei[cf]$/i.test(String(name || ''));
  }

  function createPreview({
    container,
    stage,
    image,
    note,
    zoomLabel,
    filmstrip,
    filmstripSizer,
    cache,
    onSelect,
    setStatus,
    onClose,
  }) {
    let entries = [];
    let currentPath = null;
    let open = false;

    /* ── The stage ────────────────────────────────────────────────────────── */

    /** Scale, and the offset of the image centre from the stage centre. */
    let scale = 1;
    let offsetX = 0;
    let offsetY = 0;
    /** Natural size *after* any orientation swap — what the user sees. */
    let shownWidth = 0;
    let shownHeight = 0;
    let orientation = orientationOf(1);
    /** An object URL we made and therefore have to revoke. */
    let ownedUrl = null;

    function stageSize() {
      return { width: stage.clientWidth, height: stage.clientHeight };
    }

    /**
     * The scale at which the whole photo is visible.
     *
     * Never above 1: "fit" on a photo smaller than the window means showing it
     * at its own size, not blowing it up to fill space it has no detail for.
     */
    function fitScale() {
      const { width, height } = stageSize();
      if (!shownWidth || !shownHeight || !width || !height) return 1;
      return Math.min(1, width / shownWidth, height / shownHeight);
    }

    /**
     * Keeps the image from being dragged off into empty space.
     *
     * Along an axis where the image is smaller than the stage it is pinned
     * centred; where it is larger, panning stops at its edges. Without this a
     * photo can be flicked out of the window entirely and the stage looks
     * broken rather than empty.
     */
    function clampOffsets() {
      const { width, height } = stageSize();
      const slackX = Math.max(0, (shownWidth * scale - width) / 2);
      const slackY = Math.max(0, (shownHeight * scale - height) / 2);
      offsetX = Math.min(slackX, Math.max(-slackX, offsetX));
      offsetY = Math.min(slackY, Math.max(-slackY, offsetY));
    }

    function paint() {
      clampOffsets();
      // Order matters. The element is centred first, then moved and scaled in
      // stage space, and only then rotated in its own — rotating before the
      // scale would send the pan along the image's axes rather than the
      // screen's, so dragging a sideways photo would move it sideways.
      image.style.transform =
        `translate(-50%, -50%) translate(${offsetX}px, ${offsetY}px) ` +
        `scale(${scale}) ${orientation.transform}`;
      if (zoomLabel) zoomLabel.textContent = `${Math.round(scale * 100)}%`;
    }

    /**
     * Whether the view is the fitted one.
     *
     * Tracked rather than derived: it decides what a resize does. A photo the
     * user has zoomed into must keep its magnification when the divider moves,
     * or examining detail becomes impossible while adjusting the layout. A
     * fitted photo must re-fit, or it stops fitting.
     */
    let fitted = true;

    function fit() {
      scale = fitScale();
      offsetX = 0;
      offsetY = 0;
      fitted = true;
      paint();
    }

    /**
     * Zooms to `next`, keeping whatever is under (sx, sy) under it afterwards.
     *
     * Zooming about the stage centre instead is the thing that makes a viewer
     * feel wrong: the detail being examined slides away exactly when the user
     * magnifies it, and they have to chase it with the mouse.
     */
    function zoomTo(next, sx, sy) {
      const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
      if (clamped === scale) return;
      const rect = stage.getBoundingClientRect();
      // Where the cursor is relative to the stage centre.
      const dx = (sx === undefined ? rect.width / 2 : sx - rect.left) - rect.width / 2;
      const dy = (sy === undefined ? rect.height / 2 : sy - rect.top) - rect.height / 2;
      const ratio = clamped / scale;
      offsetX = dx - ratio * (dx - offsetX);
      offsetY = dy - ratio * (dy - offsetY);
      scale = clamped;
      fitted = false;
      paint();
    }

    /* ── Loading the photo ────────────────────────────────────────────────── */

    function releaseOwnedUrl() {
      if (!ownedUrl) return;
      URL.revokeObjectURL(ownedUrl);
      ownedUrl = null;
    }

    function showNote(text) {
      note.textContent = text || '';
      note.hidden = !text;
    }

    /**
     * Resolves the largest image available for `entry`.
     *
     * For anything the webview decodes, that is the file itself at full
     * resolution. For HEIC and TIFF it is whatever ExifTool could extract —
     * typically a 160×120 EXIF thumbnail, which is honest to say so about
     * rather than present as the photo.
     *
     * **Never assigns `ownedUrl`.** A decoded blob comes back marked `owned`
     * and the caller takes ownership *after* its staleness check, because a
     * decode that loses the race must revoke its own blob rather than hand it
     * to a variable the winner is about to overwrite. See `show`.
     */
    async function resolveSource(entry) {
      if (!entry.needsPreview) {
        const url = window.NativeAPI.imageUrl(entry.path);
        // 0: the file carries its own rotation and the webview applied it.
        if (url) return { url, orientation: 0, note: '' };
      }

      // HEIC, decoded properly — no `maxEdge`, so the primary image at full
      // resolution. This is the only place in the app that asks for that: the
      // grid's tiles take the container's own thumbnail item or an extracted
      // one, because a full software HEVC decode per tile would be hundreds of
      // milliseconds each.
      if (isHeic(entry.name)) {
        showNote('Decoding…');
        const decoded = await window.ExifHeic.decodeToUrl(entry.path);
        if (decoded) {
          // Marked, not assigned: `show` takes ownership once it knows this
          // decode still matters, or revokes it on the spot if it does not.
          return {
            owned: true,
            url: decoded,
            // 0, so nothing is rotated here. HEIC stores rotation as the
            // container's own `irot`/`imir` transform properties, and libheif
            // applies those while decoding — which is why the pixels come back
            // the right way up without help. A HEIC's EXIF `Orientation`, when
            // it has one, describes the same rotation a second time; applying
            // it on top would turn the photo twice.
            orientation: 0,
            note: '',
          };
        }
      }

      let preview = null;
      try {
        preview = await window.NativeAPI.readPreview(entry.path);
      } catch (error) {
        preview = null;
      }
      if (preview && preview.base64) {
        return {
          url: `data:image/jpeg;base64,${preview.base64}`,
          orientation: preview.orientation || 1,
          // Says which of the two reasons applies. "Thumbnail only" with no
          // explanation reads as the app rendering badly; naming the missing
          // decoder is something the user can act on, and naming the format is
          // something they can stop wondering about.
          note: isHeic(entry.name)
            ? 'Showing the embedded thumbnail — the HEIC decoder is not installed, ' +
              'so this file cannot be decoded at full size.'
            : 'Showing the embedded thumbnail — no browser engine decodes this ' +
              'format, and the app has no decoder for it.',
        };
      }

      // The extension lied, or there is genuinely nothing. Try the direct
      // route as a last resort; the grid does the same, for the same reason.
      const url = window.NativeAPI.imageUrl(entry.path);
      if (url) return { url, orientation: 0, note: '' };
      return null;
    }

    function loadInto(source) {
      return new Promise((resolve) => {
        let settled = false;
        const finish = (ok) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(ok);
        };
        const timer = setTimeout(() => finish(false), DISPLAY_TIMEOUT_MS);
        const onLoad = () => {
          image.removeEventListener('load', onLoad);
          image.removeEventListener('error', onError);
          orientation = orientationOf(source.orientation);
          // A quarter turn swaps what the user sees, and every fit and clamp
          // below is in terms of that rather than the bitmap's own axes.
          shownWidth = orientation.swaps ? image.naturalHeight : image.naturalWidth;
          shownHeight = orientation.swaps ? image.naturalWidth : image.naturalHeight;
          image.style.width = `${image.naturalWidth}px`;
          image.style.height = `${image.naturalHeight}px`;
          finish(true);
        };
        const onError = () => {
          image.removeEventListener('load', onLoad);
          image.removeEventListener('error', onError);
          finish(false);
        };
        image.addEventListener('load', onLoad);
        image.addEventListener('error', onError);

        // Before `src`, not after: `naturalWidth` accounts for
        // `image-orientation`, and the whole fit is derived from it. Setting
        // the attribute once the image had already loaded would mean measuring
        // it under one rule and displaying it under another.
        //
        // Cleared as well as set, because the stage reuses one <img> across
        // photos — a directly decoded photo following an extracted one would
        // otherwise inherit the attribute and lose the webview's own rotation.
        if (source.orientation >= 1) image.dataset.orient = String(source.orientation);
        else delete image.dataset.orient;
        image.src = source.url;
      });
    }

    /** Guards against a slower load for an older photo winning the race. */
    let loadToken = 0;

    async function show(path) {
      const entry = entries.find((e) => e.path === path);
      if (!entry) return;
      currentPath = path;
      markStripSelection();
      scrollStripTo(path);

      const token = ++loadToken;
      showNote('');
      image.hidden = true;
      container.classList.add('loading');

      // The *outgoing* photo's blob is released here, before the next one is
      // resolved — never after. `resolveSource` is what creates the new blob,
      // so releasing on the far side of it would revoke the URL that was just
      // made, and the stage would load nothing at all.
      releaseOwnedUrl();

      const source = await resolveSource(entry);
      if (token !== loadToken) {
        // A superseded decode owns a blob nobody will ever display. Revoking
        // it here is the only chance: `releaseOwnedUrl` already ran for the
        // photo that overtook this one, and the assignment below belongs to
        // that photo now — so a blob left unrevoked here is unreachable, and
        // arrowing through a folder leaks a full-resolution JPEG per step.
        if (source && source.owned) URL.revokeObjectURL(source.url);
        return;
      }
      // Ownership transfers only once this load is known to be the live one.
      if (source && source.owned) ownedUrl = source.url;

      if (!source) {
        container.classList.remove('loading');
        image.removeAttribute('src');
        showNote('No preview available for this file.');
        return;
      }

      const ok = await loadInto(source);
      if (token !== loadToken) return;

      container.classList.remove('loading');
      if (!ok) {
        image.hidden = true;
        showNote('This file could not be displayed.');
        return;
      }
      image.hidden = false;
      showNote(source.note);
      fit();
    }

    /* ── Filmstrip ────────────────────────────────────────────────────────── */

    const mounted = new Map();
    const queue = [];
    const queued = new Set();
    const inFlight = new Set();
    let stripFrame = null;

    cache.addEvictListener((path) => {
      const tile = mounted.get(path);
      if (!tile) return;
      tile.replaceChildren();
      scheduleStrip();
    });

    function stripLayout() {
      filmstripSizer.style.width = `${Math.max(
        0,
        entries.length * (THUMB + THUMB_GAP) - THUMB_GAP
      )}px`;
    }

    function stripRange() {
      const step = THUMB + THUMB_GAP;
      const first = Math.max(0, Math.floor(filmstrip.scrollLeft / step) - OVERSCAN);
      const count = Math.ceil(filmstrip.clientWidth / step) + 2 * OVERSCAN;
      return { start: first, end: Math.min(entries.length, first + count) };
    }

    function buildThumbImage(record) {
      const img = document.createElement('img');
      img.decoding = 'async';
      img.alt = '';
      // See grid.js buildImage: 0 means the webview already oriented it, and
      // the attribute is what scopes `image-orientation: none` to the
      // extracted blobs that actually need it.
      if (record.orientation >= 1) img.dataset.orient = String(record.orientation);
      img.src = record.url;
      return img;
    }

    function buildThumb(entry, index) {
      const tile = document.createElement('div');
      tile.className = 'strip-tile';
      tile.dataset.path = entry.path;
      tile.title = entry.name;
      tile.style.transform = `translateX(${index * (THUMB + THUMB_GAP)}px)`;
      const record = cache.get(entry.path);
      if (record) tile.appendChild(buildThumbImage(record));
      tile.addEventListener('click', () => onSelect(entry.path));
      return tile;
    }

    function probeThumb(path, record) {
      return new Promise((resolve) => {
        const img = buildThumbImage(record);
        let settled = false;
        const finish = (ok) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(ok);
        };
        const timer = setTimeout(() => finish(false), DISPLAY_TIMEOUT_MS);
        img.addEventListener('load', () => {
          const live = mounted.get(path);
          if (live) live.replaceChildren(img);
          finish(true);
        });
        img.addEventListener('error', () => finish(false));
      });
    }

    async function resolveThumb(entry) {
      const path = entry.path;
      inFlight.add(path);
      try {
        const direct = () => {
          const url = window.NativeAPI.imageUrl(path);
          return url ? { url, orientation: 0 } : null;
        };
        const extracted = async () => {
          const preview = await window.NativeAPI.readPreview(path);
          if (!preview || !preview.base64) return null;
          return {
            url: `data:image/jpeg;base64,${preview.base64}`,
            orientation: preview.orientation || 1,
          };
        };
        const routes = entry.needsPreview
          ? [extracted, async () => direct()]
          : [async () => direct(), extracted];

        for (const route of routes) {
          let record = null;
          try {
            record = await route();
          } catch (_) {
            continue;
          }
          if (!record) continue;
          if (await probeThumb(path, record)) {
            cache.set(path, record);
            return;
          }
        }
        cache.set(path, null);
      } finally {
        inFlight.delete(path);
        pumpStrip();
      }
    }

    function pumpStrip() {
      while (inFlight.size < MAX_INFLIGHT_PREVIEWS && queue.length) {
        const entry = queue.shift();
        queued.delete(entry.path);
        if (!mounted.has(entry.path)) continue;
        if (inFlight.has(entry.path)) continue;
        if (cache.has(entry.path)) continue;
        resolveThumb(entry);
      }
    }

    function enqueueThumb(entry) {
      const path = entry.path;
      if (queued.has(path) || inFlight.has(path) || cache.has(path)) return;
      queued.add(path);
      queue.push(entry);
    }

    function renderStrip() {
      stripFrame = null;
      if (!open) return;
      const { start, end } = stripRange();
      const wanted = new Set();

      for (let i = start; i < end; i += 1) {
        const entry = entries[i];
        if (!entry) continue;
        wanted.add(entry.path);
        let tile = mounted.get(entry.path);
        if (!tile) {
          tile = buildThumb(entry, i);
          mounted.set(entry.path, tile);
          filmstripSizer.appendChild(tile);
        } else {
          tile.style.transform = `translateX(${i * (THUMB + THUMB_GAP)}px)`;
        }
        enqueueThumb(entry);
        tile.classList.toggle('current', entry.path === currentPath);
      }

      for (const [path, tile] of mounted) {
        if (!wanted.has(path)) {
          tile.remove();
          mounted.delete(path);
        }
      }
      pumpStrip();
    }

    function scheduleStrip() {
      if (stripFrame !== null) return;
      stripFrame = requestAnimationFrame(renderStrip);
    }

    function markStripSelection() {
      for (const [path, tile] of mounted) {
        tile.classList.toggle('current', path === currentPath);
      }
    }

    /** Brings the current photo into the strip, centred where possible. */
    function scrollStripTo(path) {
      const index = entries.findIndex((e) => e.path === path);
      if (index === -1) return;
      const step = THUMB + THUMB_GAP;
      const target = index * step - (filmstrip.clientWidth - THUMB) / 2;
      filmstrip.scrollLeft = Math.max(0, target);
      scheduleStrip();
    }

    function unmountStrip() {
      for (const tile of mounted.values()) tile.remove();
      mounted.clear();
      queue.length = 0;
      queued.clear();
    }

    /* ── Pointer interaction ──────────────────────────────────────────────── */

    let panning = false;
    let panFromX = 0;
    let panFromY = 0;

    stage.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      panning = true;
      panFromX = event.clientX - offsetX;
      panFromY = event.clientY - offsetY;
      stage.setPointerCapture(event.pointerId);
      stage.classList.add('panning');
      event.preventDefault();
    });

    stage.addEventListener('pointermove', (event) => {
      if (!panning) return;
      offsetX = event.clientX - panFromX;
      offsetY = event.clientY - panFromY;
      paint();
    });

    const endPan = (event) => {
      if (!panning) return;
      panning = false;
      stage.classList.remove('panning');
      if (stage.hasPointerCapture(event.pointerId)) {
        stage.releasePointerCapture(event.pointerId);
      }
    };
    stage.addEventListener('pointerup', endPan);
    stage.addEventListener('pointercancel', endPan);
    stage.addEventListener('lostpointercapture', endPan);

    stage.addEventListener(
      'wheel',
      (event) => {
        if (!open) return;
        // Otherwise the webview treats it as a page scroll and the whole app
        // shifts under the photo.
        event.preventDefault();
        const direction = event.deltaY < 0 ? 1 : -1;
        zoomTo(scale * ZOOM_STEP ** direction, event.clientX, event.clientY);
      },
      { passive: false }
    );

    // Toggle between fit and actual size, the way every image viewer does.
    stage.addEventListener('dblclick', (event) => {
      if (Math.abs(scale - fitScale()) < 0.001) zoomTo(1, event.clientX, event.clientY);
      else fit();
    });

    filmstrip.addEventListener('scroll', scheduleStrip, { passive: true });

    // Vertical wheel over a horizontal strip should move it, not do nothing.
    filmstrip.addEventListener(
      'wheel',
      (event) => {
        if (event.deltaX !== 0) return;
        event.preventDefault();
        filmstrip.scrollLeft += event.deltaY;
      },
      { passive: false }
    );

    // The stage is resized by the divider and by the window. A fitted photo
    // has to re-fit or it stops fitting; a zoomed one has to keep its
    // magnification, or examining detail becomes impossible while adjusting
    // the layout.
    new ResizeObserver(() => {
      if (!open) return;
      if (fitted) fit();
      else paint();
      scheduleStrip();
    }).observe(stage);

    /* ── Public surface ───────────────────────────────────────────────────── */

    function step(delta) {
      const index = entries.findIndex((e) => e.path === currentPath);
      if (index === -1) return;
      const next = entries[index + delta];
      if (next) onSelect(next.path);
    }

    function closePreview() {
      if (!open) return;
      open = false;
      container.hidden = true;
      // Stop a load in flight from painting into a hidden stage.
      loadToken += 1;
      releaseOwnedUrl();
      image.removeAttribute('src');
      unmountStrip();
      // Preview mode can end without anyone pressing anything — `setEntries`
      // closes it when the photo being shown is filtered away. Everything else
      // that has to change is the app's: the grid's tiles, the scroller, the
      // toolbar. Closing silently left all three in preview state with nothing
      // on screen, so the app is told either way and works out the rest.
      if (onClose) onClose();
    }

    function openPreview(path) {
      if (!entries.length) return;
      open = true;
      container.hidden = false;
      stripLayout();
      scheduleStrip();
      show(path || (entries[0] && entries[0].path));
      if (setStatus) {
        setStatus('Preview — arrow keys to move, scroll to zoom, Esc to close');
      }
    }

    function setEntries(next) {
      entries = next;
      unmountStrip();
      stripLayout();
      if (!open) return;
      // The photo being previewed may have been filtered out from under us.
      if (!entries.some((e) => e.path === currentPath)) {
        if (entries.length) show(entries[0].path);
        else closePreview();
        return;
      }
      scheduleStrip();
    }

    /** Follows the app's selection; never sets it. */
    function setCurrent(path) {
      if (!open || !path || path === currentPath) {
        currentPath = path;
        markStripSelection();
        return;
      }
      show(path);
    }

    return {
      isOpen: () => open,
      setEntries,
      setCurrent,
      /**
       * Re-reads the current photo from disk.
       *
       * For after a write: the file has changed, so the pixels on the stage are
       * of a version that no longer exists. `setCurrent` would not do it — it
       * short-circuits when the path is unchanged, which is exactly the case
       * here.
       */
      refresh() {
        if (open && currentPath) show(currentPath);
      },
      open: openPreview,
      close: closePreview,
      next: () => step(1),
      previous: () => step(-1),
      fit,
      actualSize: () => zoomTo(1),
      zoomIn: () => zoomTo(scale * ZOOM_STEP),
      zoomOut: () => zoomTo(scale / ZOOM_STEP),
      /** The path being shown, for landing the grid on it when closing. */
      current: () => currentPath,
    };
  }

  window.ExifPreview = { createPreview };
})();
