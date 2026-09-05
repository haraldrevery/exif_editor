/**
 * native_api.js — Revery Exif adapter layer
 *
 * Exposes a single `window.NativeAPI` that the rest of the frontend calls for
 * every OS interaction. Mirrors the abstraction in Revery Notebook, for the
 * same reason: the app code never learns which wrapper it is running under, so
 * an Electron wrapper can be added later without touching a single caller.
 *
 * Invariant: nothing outside this file may reference `window.__TAURI__`.
 *
 * Load order: first script in <head>, before any module that uses it.
 */

(function () {
  'use strict';

  const isTauri = typeof window.__TAURI__ !== 'undefined';
  const isElectron = typeof window.exifAPI !== 'undefined';
  const ENV = isTauri ? 'tauri' : isElectron ? 'electron' : 'web';

  function notSupported(name) {
    return Promise.reject(
      new Error(
        `NativeAPI.${name}() needs the desktop app. ` +
          `Open Revery Exif via the Tauri or Electron wrapper.`
      )
    );
  }

  /* ── Tauri ───────────────────────────────────────────────────────────── */

  /* A Tauri rejection is always a real refusal. `invoke` has no client-side
     timeout, so nothing here can give up on a call that is still running, and
     the backend pre-flights every file before writing any of them. There is
     therefore no unconfirmed state to represent — which is why only the
     Electron adapter below carries one. */

  const tauriImpl = {
    env: 'tauri',

    async chooseFolder() {
      const { open } = window.__TAURI__.dialog;
      const picked = await open({ directory: true, multiple: false });
      // The dialog returns null when the user cancels — not an error.
      return picked || null;
    },

    openLibrary(path) {
      return window.__TAURI__.core.invoke('open_library', { path });
    },

    rescanLibrary() {
      return window.__TAURI__.core.invoke('rescan_library');
    },

    readMetadata(paths) {
      return window.__TAURI__.core.invoke('read_metadata', { paths });
    },

    readFields(paths, tags) {
      return window.__TAURI__.core.invoke('read_fields', { paths, tags });
    },

    readPreview(path) {
      return window.__TAURI__.core.invoke('read_preview', { path });
    },

    readFileBytes(path) {
      return window.__TAURI__.core.invoke('read_file_bytes', { path });
    },

    setDirty(dirty, count) {
      return window.__TAURI__.core.invoke('set_dirty', { dirty, count });
    },

    readThumbCache(path, edge) {
      return window.__TAURI__.core.invoke('read_thumb_cache', { path, edge });
    },

    writeThumbCache(path, edge, base64) {
      return window.__TAURI__.core.invoke('write_thumb_cache', { path, edge, base64 });
    },

    engineVersion() {
      return window.__TAURI__.core.invoke('engine_version');
    },

    writableTags() {
      return window.__TAURI__.core.invoke('writable_tags');
    },

    initialFolder() {
      return window.__TAURI__.core.invoke('initial_folder');
    },

    applyEdit(paths, edit) {
      return window.__TAURI__.core.invoke('apply_edit', { paths, edit });
    },

    applyEdits(edits) {
      return window.__TAURI__.core.invoke('apply_edits', { edits });
    },

    undoLast() {
      return window.__TAURI__.core.invoke('undo_last');
    },

    undoAvailable() {
      return window.__TAURI__.core.invoke('undo_available');
    },

    chooseGpxFile() {
      return window.__TAURI__.core.invoke('choose_gpx_file');
    },

    /**
     * Saves a CSV the frontend built. The command opens the save dialog
     * itself, so no path crosses this boundary; resolves to what was written,
     * or null if the dialog was dismissed.
     */
    exportCsv(csv, suggestedName) {
      return window.__TAURI__.core.invoke('export_csv', {
        csv,
        suggestedName: suggestedName ?? null,
      });
    },

    previewGeotag(paths, gpxPath, offsetSeconds, maxGapSeconds) {
      return window.__TAURI__.core.invoke('preview_geotag', {
        paths,
        gpxPath,
        offsetSeconds,
        maxGapSeconds: maxGapSeconds ?? null,
      });
    },

    applyGeotag(matches) {
      return window.__TAURI__.core.invoke('apply_geotag', { matches });
    },

    reportRenderer(detail) {
      return window.__TAURI__.core.invoke('report_renderer', { detail });
    },

    previewDateShift(paths, seconds) {
      return window.__TAURI__.core.invoke('preview_date_shift', { paths, seconds });
    },

    /**
     * A URL the webview can load a local image from. Only valid for folders
     * granted by openLibrary(); anything else is blocked by the asset scope.
     */
    imageUrl(path) {
      return window.__TAURI__.core.convertFileSrc(path);
    },
  };

  /* ── Electron ────────────────────────────────────────────────────────────
     preload.js exposes the same method names, so this is a rename rather than
     a translation. The one real difference is imageUrl: Electron has no asset
     protocol, and the page is loaded from file://, so a file:// URL works
     directly.                                                              */

  /**
   * Marker `core_client.js` puts on an error where the write may have gone
   * ahead anyway — a request that outran its timeout, or a child that died
   * mid-batch. See the comment on `UNCONFIRMED` there.
   */
  const UNCONFIRMED = 'E_UNCONFIRMED:';

  /**
   * Turns the marker back into something the caller can branch on.
   *
   * It has to travel as text: `ipcRenderer.invoke` serialises a rejection down
   * to its message and drops every other property, so a boolean set in the
   * main process does not survive the trip. Electron also wraps the message
   * ("Error invoking remote method 'apply_edits': Error: …"), which is why the
   * marker is searched for rather than matched at the start.
   *
   * Applied to every call, not only the writes: a read that came back
   * unconfirmed says the engine is in trouble, and the caller may want to say
   * so rather than blame the file.
   */
  function call(promise) {
    return promise.catch((error) => {
      const text = String((error && error.message) || error);
      const at = text.indexOf(UNCONFIRMED);
      if (at === -1) throw error;
      const wrapped = new Error(text.slice(at + UNCONFIRMED.length).trim());
      // The whole point: "we do not know what happened" is a third answer,
      // distinct from success and from a refusal that wrote nothing.
      wrapped.unconfirmed = true;
      throw wrapped;
    });
  }

  const electronImpl = {
    env: 'electron',

    chooseFolder: () => window.exifAPI.chooseFolder(),
    chooseGpxFile: () => window.exifAPI.chooseGpxFile(),
    exportCsv: (csv, suggestedName) =>
      window.exifAPI.exportCsv(csv, suggestedName ?? null),
    initialFolder: () => window.exifAPI.initialFolder(),
    engineVersion: () => window.exifAPI.engineVersion(),
    writableTags: () => window.exifAPI.writableTags(),
    reportRenderer: (detail) => window.exifAPI.reportRenderer(detail),

    openLibrary: (path) => call(window.exifAPI.openLibrary(path)),
    rescanLibrary: () => call(window.exifAPI.rescanLibrary()),
    readMetadata: (paths) => call(window.exifAPI.readMetadata(paths)),
    readFields: (paths, tags) => call(window.exifAPI.readFields(paths, tags)),
    readPreview: (path) => call(window.exifAPI.readPreview(path)),
    readFileBytes: (path) => call(window.exifAPI.readFileBytes(path)),
    setDirty: (dirty, count) => window.exifAPI.setDirty(dirty, count),
    readThumbCache: (path, edge) => window.exifAPI.readThumbCache(path, edge),
    writeThumbCache: (path, edge, base64) =>
      window.exifAPI.writeThumbCache(path, edge, base64),
    applyEdit: (paths, edit) => call(window.exifAPI.applyEdit(paths, edit)),
    applyEdits: (edits) => call(window.exifAPI.applyEdits(edits)),
    previewGeotag: (paths, gpxPath, offsetSeconds, maxGapSeconds) =>
      call(window.exifAPI.previewGeotag(paths, gpxPath, offsetSeconds, maxGapSeconds ?? null)),
    applyGeotag: (matches) => call(window.exifAPI.applyGeotag(matches)),
    previewDateShift: (paths, seconds) => call(window.exifAPI.previewDateShift(paths, seconds)),
    undoLast: () => call(window.exifAPI.undoLast()),
    undoAvailable: () => window.exifAPI.undoAvailable(),

    imageUrl(path) {
      // Delegated to `state.js` so the conversion is testable without a
      // `window` — see `ExifState.fileUrl` for why a native Windows path needs
      // more than percent-encoding. Read at call time, not load time: this
      // file is deliberately the first script in <head>, before `state.js`.
      return window.ExifState.fileUrl(path);
    },
  };

  /* ── Web fallback ────────────────────────────────────────────────────── */

  const webImpl = {
    env: 'web',
    chooseFolder: () => notSupported('chooseFolder'),
    openLibrary: () => notSupported('openLibrary'),
    rescanLibrary: () => notSupported('rescanLibrary'),
    readMetadata: () => notSupported('readMetadata'),
    readFields: () => notSupported('readFields'),
    readPreview: () => notSupported('readPreview'),
    readFileBytes: () => notSupported('readFileBytes'),
    // A miss and a no-op, not a rejection: the cache is an optimisation, and
    // the decode path has to work identically without it.
    readThumbCache: () => Promise.resolve(null),
    writeThumbCache: () => Promise.resolve(),
    // No window to guard; `beforeunload` in app.js is the whole guard here.
    setDirty: () => Promise.resolve(),
    engineVersion: () => notSupported('engineVersion'),
    writableTags: () => notSupported('writableTags'),
    initialFolder: () => Promise.resolve(null),
    applyEdit: () => notSupported('applyEdit'),
    applyEdits: () => notSupported('applyEdits'),
    undoLast: () => notSupported('undoLast'),
    undoAvailable: () => Promise.resolve(false),
    chooseGpxFile: () => notSupported('chooseGpxFile'),
    exportCsv: () => notSupported('exportCsv'),
    previewGeotag: () => notSupported('previewGeotag'),
    applyGeotag: () => notSupported('applyGeotag'),
    reportRenderer: () => Promise.resolve(),
    previewDateShift: () => notSupported('previewDateShift'),
    imageUrl: (path) => path,
  };

  window.NativeAPI =
    ENV === 'tauri' ? tauriImpl : ENV === 'electron' ? electronImpl : webImpl;
  window.NativeAPI.ENV = ENV;
})();
