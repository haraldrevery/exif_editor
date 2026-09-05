/**
 * preload.js — the only surface the renderer gets.
 *
 * Exposes `window.exifAPI`, which `www/js/native_api.js` adapts into the same
 * `window.NativeAPI` the Tauri build provides. Nothing else crosses the
 * boundary: no Node, no `ipcRenderer`, no filesystem.
 *
 * The method names deliberately match the Tauri command names one for one, so
 * the adapter stays a rename rather than a translation layer.
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, args) => ipcRenderer.invoke(channel, args);

contextBridge.exposeInMainWorld('exifAPI', {
  engineVersion: () => invoke('engine_version'),
  writableTags: () => invoke('writable_tags'),
  chooseFolder: () => invoke('choose_folder'),
  chooseGpxFile: () => invoke('choose_gpx_file'),
  exportCsv: (csv, suggestedName) => invoke('export_csv', { csv, suggestedName }),
  initialFolder: () => invoke('initial_folder'),
  reportRenderer: (detail) => invoke('report_renderer', detail),

  openLibrary: (path) => invoke('open_library', { path }),
  rescanLibrary: () => invoke('rescan_library'),
  readMetadata: (paths) => invoke('read_metadata', { paths }),
  readFields: (paths, tags) => invoke('read_fields', { paths, tags }),
  readPreview: (path) => invoke('read_preview', { path }),
  readFileBytes: (path) => invoke('read_file_bytes', { path }),
  setDirty: (dirty, count) => invoke('set_dirty', { dirty, count }),
  readThumbCache: (path, edge) => invoke('read_thumb_cache', { path, edge }),
  writeThumbCache: (path, edge, base64) => invoke('write_thumb_cache', { path, edge, base64 }),
  applyEdit: (paths, edit) => invoke('apply_edit', { paths, edit }),
  applyEdits: (edits) => invoke('apply_edits', { edits }),
  previewGeotag: (paths, gpxPath, offsetSeconds, maxGapSeconds) =>
    invoke('preview_geotag', { paths, gpxPath, offsetSeconds, maxGapSeconds }),
  applyGeotag: (matches) => invoke('apply_geotag', { matches }),
  previewDateShift: (paths, seconds) => invoke('preview_date_shift', { paths, seconds }),
  undoLast: () => invoke('undo_last'),
  undoAvailable: () => invoke('undo_available'),
});
