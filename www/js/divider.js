/**
 * divider.js — the draggable boundary between the grid and the side panel.
 *
 * Sets `--panel-width` as an *inline* style on the document element, which is
 * what makes this work at all: the same variable is declared in `:root` and
 * overridden in the narrow-window media query, and an inline style outranks
 * both. Writing to a stylesheet rule instead would leave the media query
 * silently winning below 980px, which is exactly the width at which someone is
 * most likely to be adjusting the panel.
 *
 * # Pointer capture, not document listeners
 *
 * A drag is tracked with `setPointerCapture` rather than by listening on
 * `document`. The difference shows up when the pointer moves faster than the
 * webview repaints and leaves the window: with document listeners the events
 * simply stop arriving, the divider freezes mid-drag, and the button-up that
 * happens outside is never seen — so the drag is still "live" when the pointer
 * comes back. Capture routes every event to the divider until it is released,
 * wherever the pointer goes.
 */

(function () {
  'use strict';

  /** Narrower than this and the panel's own two-column field rows collapse. */
  const MIN_PANEL = 280;
  /**
   * Space the grid keeps whatever the panel does.
   *
   * Two tile columns plus their gaps — below that the grid stops being a grid
   * and the panel has taken over a window the user opened to look at photos.
   */
  const MIN_GRID = 400;
  /** One arrow-key press. Coarse enough to be useful, fine enough to aim. */
  const KEY_STEP = 16;

  /** See prefs.js for why every storage access is wrapped. */
  const prefs = window.ExifPrefs;
  const STORAGE_KEY = prefs.KEY_PANEL_WIDTH;

  function createDivider({ divider, onResize }) {
    const root = document.documentElement;
    let width = 0;
    let frame = null;
    let pending = null;

    /**
     * The widest the panel may be right now.
     *
     * Recomputed rather than stored: the window can be resized while the panel
     * keeps its width, and a panel that was legal at 1600px is not at 900px.
     */
    function maxPanel() {
      return Math.max(MIN_PANEL, window.innerWidth - MIN_GRID);
    }

    function clamp(value) {
      return Math.min(Math.max(value, MIN_PANEL), maxPanel());
    }

    /** Applies a width immediately. Cheap: one custom property write. */
    function paint(next) {
      width = next;
      root.style.setProperty('--panel-width', `${Math.round(next)}px`);
      divider.setAttribute('aria-valuenow', String(Math.round(next)));
      divider.setAttribute('aria-valuemin', String(MIN_PANEL));
      divider.setAttribute('aria-valuemax', String(Math.round(maxPanel())));
      if (onResize) onResize(Math.round(next));
    }

    /**
     * Coalesces to one write per frame.
     *
     * A pointer can deliver events faster than the compositor draws, and every
     * width change reflows the grid behind it. Without this the drag does the
     * layout work several times over for frames nobody ever sees.
     */
    function schedule(next) {
      pending = next;
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        if (pending !== null) paint(pending);
        pending = null;
      });
    }

    /* ── Dragging ─────────────────────────────────────────────────────────── */

    let dragging = false;

    divider.addEventListener('pointerdown', (event) => {
      // Primary button only: a right-click here should open nothing and drag
      // nothing.
      if (event.button !== 0) return;
      dragging = true;
      divider.setPointerCapture(event.pointerId);
      divider.classList.add('dragging');
      event.preventDefault();
    });

    divider.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      // Measured from the right edge of the window, because that is the edge
      // the panel is anchored to. Deriving it from a stored start offset
      // instead accumulates error over a long drag.
      schedule(clamp(window.innerWidth - event.clientX));
    });

    const endDrag = (event) => {
      if (!dragging) return;
      dragging = false;
      divider.classList.remove('dragging');
      if (divider.hasPointerCapture(event.pointerId)) {
        divider.releasePointerCapture(event.pointerId);
      }
      // Flush anything the last frame did not get to, then remember it.
      if (pending !== null) {
        paint(pending);
        pending = null;
      }
      prefs.writeNumber(STORAGE_KEY, width);
    };

    divider.addEventListener('pointerup', endDrag);
    // Fires when capture is lost some other way — the window losing focus
    // mid-drag, or the OS taking over the pointer. Without it the divider
    // would still believe it was being dragged.
    divider.addEventListener('pointercancel', endDrag);
    divider.addEventListener('lostpointercapture', endDrag);

    // Snap back to a sensible default, the way a window manager's double-click
    // on a border does.
    divider.addEventListener('dblclick', () => {
      paint(clamp(380));
      prefs.writeNumber(STORAGE_KEY, width);
    });

    /* ── Keyboard ─────────────────────────────────────────────────────────── */

    divider.addEventListener('keydown', (event) => {
      let delta = 0;
      // Left grows the panel: the panel is on the right, so its edge moving
      // left makes it wider. This is the direction that matches what the user
      // is dragging, not what the number does.
      if (event.key === 'ArrowLeft') delta = KEY_STEP;
      else if (event.key === 'ArrowRight') delta = -KEY_STEP;
      else if (event.key === 'Home') delta = maxPanel() - width;
      else if (event.key === 'End') delta = MIN_PANEL - width;
      else return;
      event.preventDefault();
      paint(clamp(width + delta));
      prefs.writeNumber(STORAGE_KEY, width);
    });

    /* ── Window resize ────────────────────────────────────────────────────── */

    window.addEventListener('resize', () => {
      // Re-clamp rather than re-store: shrinking the window should not
      // permanently forget the width the user chose for a large one.
      const next = clamp(width);
      if (next !== width) paint(next);
      else divider.setAttribute('aria-valuemax', String(Math.round(maxPanel())));
    });

    /* ── Boot ─────────────────────────────────────────────────────────────── */

    // A remembered width, or whatever the stylesheet already says. Reading the
    // computed value rather than hardcoding a default keeps the fallback in
    // one place — the CSS — instead of two that can drift.
    const remembered = prefs.readNumber(STORAGE_KEY, null);
    const fromCss = Number.parseFloat(
      getComputedStyle(root).getPropertyValue('--panel-width')
    );
    paint(clamp(remembered || (Number.isFinite(fromCss) ? fromCss : 380)));

    return {
      width: () => width,
      set(value) {
        paint(clamp(value));
        prefs.writeNumber(STORAGE_KEY, width);
      },
    };
  }

  window.ExifDivider = { createDivider };
})();
