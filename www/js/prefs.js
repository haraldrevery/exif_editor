/**
 * prefs.js — the small settings that persist between launches.
 *
 * Panel width, thumbnail size: things the user adjusts once and expects to
 * find where they left them. Not metadata, and nothing here ever touches a
 * photo.
 *
 * # Why every access is wrapped
 *
 * Storage is not guaranteed. The Electron shell loads the page from a
 * `file://` origin, where whether storage works at all is a browser decision
 * rather than something the app controls; a private-mode window or a full
 * quota can throw on write in any shell. These run during boot, before a
 * folder is open, so an uncaught throw here does not cost a preference — it
 * costs the whole frontend.
 *
 * So a failure degrades to session-only and says nothing. Someone who has to
 * re-drag a divider has lost a second; someone staring at a blank window has
 * lost the app.
 *
 * (Both shells were checked: WebKitGTK on `tauri://localhost` and Chromium on
 * `file://` both persist. The wrapper is for the cases that were not checked.)
 */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.ExifPrefs = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * What was stored under `key` when storage is unavailable.
   *
   * Keeps a preference working for the rest of the session even when nothing
   * can be written to disk, so the app behaves consistently either way rather
   * than appearing to ignore the control.
   */
  const memory = new Map();

  function readNumber(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
      const value = Number.parseFloat(raw);
      if (Number.isFinite(value)) return value;
    } catch (_) {
      const value = memory.get(key);
      if (typeof value === 'number') return value;
    }
    return fallback;
  }

  function writeNumber(key, value) {
    memory.set(key, value);
    try {
      window.localStorage.setItem(key, String(Math.round(value)));
    } catch (_) {
      /* Session-only. Not worth telling the user about. */
    }
  }

  /**
   * The same contract for a value that is not a number.
   *
   * Used for the export's column selection, which is a comma-joined list of
   * keys. Callers validate what comes back against what this build knows
   * about — a stored key from a later version must not resurrect a column that
   * no longer exists.
   */
  function readText(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
      if (typeof raw === 'string') return raw;
    } catch (_) {
      const value = memory.get(key);
      if (typeof value === 'string') return value;
    }
    return fallback;
  }

  function writeText(key, value) {
    memory.set(key, String(value));
    try {
      window.localStorage.setItem(key, String(value));
    } catch (_) {
      /* Session-only. Not worth telling the user about. */
    }
  }

  return {
    readNumber,
    writeNumber,
    readText,
    writeText,
    KEY_PANEL_WIDTH: 'revery.exif.panelWidth',
    KEY_THUMB_SIZE: 'revery.exif.thumbSize',
    KEY_EXPORT_COLUMNS: 'revery.exif.exportColumns',
    KEY_EXPORT_PROTECT: 'revery.exif.exportProtect',
  };
});
