/**
 * app.js — wiring. Owns the app state and connects grid, panel and NativeAPI.
 */

(function () {
  'use strict';

  const S = window.ExifState;

  const el = {
    openFolder: document.getElementById('open-folder'),
    rescan: document.getElementById('rescan'),
    undo: document.getElementById('undo'),
    filter: document.getElementById('filter'),
    count: document.getElementById('count'),
    scroller: document.getElementById('grid-scroll'),
    sizer: document.getElementById('grid-sizer'),
    emptyState: document.getElementById('empty-state'),
    statusText: document.getElementById('status-text'),
    status: document.getElementById('status'),
    engineVersion: document.getElementById('engine-version'),
    previewToggle: document.getElementById('preview-toggle'),
    previewToggleLabel: document.getElementById('preview-toggle-label'),
    // The toggle's glyph. Queried rather than given an id: it is the button's
    // only icon, and every other icon in the app is addressed the same way.
    previewToggleIcon: document.querySelector('#preview-toggle .icon'),
    thumbSize: document.getElementById('thumb-size'),
  };

  /** Every photo in the open folder, in display order. */
  let allEntries = [];
  /** The open folder, kept only so an export can suggest a file name for it. */
  let openFolder = null;
  /** What the filter leaves visible — the order selection ranges follow. */
  let visibleEntries = [];
  let selection = S.createSelection();
  /** path -> ExifTool tag object, for files whose metadata has been read. */
  const metadataCache = new Map();
  /** Guards against an older, slower read overwriting a newer selection. */
  let readToken = 0;

  /**
   * path -> what the user has typed but not applied.
   *
   * Keyed by the same path strings as `metadataCache`, and for the same
   * reason: ExifTool reports `SourceFile` as *its own* rendering of the
   * argument, rewriting every separator to a forward slash on Windows. Keying
   * drafts by what came back would put them under `C:/photos/a.jpg` while the
   * selection, the cache and the write path all say `C:\photos\a.jpg` — so
   * every draft would be invisible to the code that has to find it, on Windows
   * only, where nobody is developing.
   *
   * Drafts hold raw typed values and no baseline; see the note in state.js.
   */
  const drafts = new Map();

  const panel = window.ExifPanel.createPanel({
    tabs: [...document.querySelectorAll('.tab')],
    panels: [...document.querySelectorAll('.tab-panel')],
    editHint: document.getElementById('edit-hint'),
    editFields: document.getElementById('edit-fields'),
    inspector: document.getElementById('inspector'),
    inspectorFilter: document.getElementById('inspector-filter'),
    footer: document.getElementById('pending-bar'),
    footerText: document.getElementById('pending-text'),
    reviewButton: document.getElementById('review'),
    applyButton: document.getElementById('apply'),
    revertButton: document.getElementById('revert'),
    dialog: document.getElementById('review-dialog'),
    dialogBody: document.getElementById('review-body'),
    dialogConfirm: document.getElementById('review-confirm'),
    dialogCancel: document.getElementById('review-cancel'),
    tagDialog: document.getElementById('tag-dialog'),
    tagDialogTitle: document.getElementById('tag-dialog-title'),
    tagDialogHint: document.getElementById('tag-dialog-hint'),
    tagDialogValue: document.getElementById('tag-dialog-value'),
    tagDialogConfirm: document.getElementById('tag-dialog-ok'),
    tagDialogCancel: document.getElementById('tag-dialog-cancel'),
    addTagButton: document.getElementById('add-tag'),
    tagPicker: document.getElementById('tag-picker'),
    tagPickerFilter: document.getElementById('tag-picker-filter'),
    tagPickerList: document.getElementById('tag-picker-list'),
    tagPickerCancel: document.getElementById('tag-picker-cancel'),
    onApply: applyEdit,
    onLoadTags: () => window.NativeAPI.writableTags(),
    onShowMap: () => {
      map.refreshSize();
      renderMap();
    },
    onPositionTyped: (position) => stagePosition(position, 'typed — not saved yet.'),
    onCollectEdits: collectEdits,
    onRevert: () => {
      for (const path of selection.paths) drafts.delete(path);
      refreshDraftUi();
      panel.refreshCounts();
    },
    onDraftChanged: captureDrafts,
    onDraftCounts: draftCounts,
  });

  /* ── Drafts ───────────────────────────────────────────────────────────────
     What the user has typed but not applied, kept per file so that clicking
     another photo does not throw it away. Nothing here writes to disk.      */

  /**
   * Copies what is in the panel into every selected file's draft.
   *
   * Fans one typed value across the whole selection, which is what the panel
   * has always meant by editing several photos at once — the difference is
   * only that it now survives the selection moving on.
   */
  function captureDrafts() {
    if (!selection.paths.length) return;
    const typed = panel.captureDraft();

    for (const path of selection.paths) {
      const existing = drafts.get(path) || S.EMPTY_DRAFT;
      // **Merged over what the file already had, never replacing it.**
      // The panel holds one value per field for the whole selection, so a
      // field whose drafts disagree is deliberately absent from `typed` — it
      // shows as "mixed" and is left to each file. Overwriting the stored
      // draft with the panel's view would therefore wipe both photos' edits
      // the instant they were selected together, which is precisely when the
      // user is least expecting to lose them.
      const merged = {
        pending: { ...existing.pending, ...typed.pending },
        // Only when the panel actually carries one: on a multi-selection it
        // has no coordinate to offer, and `undefined` there means "nothing to
        // say", not "remove what this photo had staged".
        gpsPending: typed.gpsPending !== undefined ? typed.gpsPending : existing.gpsPending,
        tagPending: { ...existing.tagPending, ...typed.tagPending },
      };
      if (S.draftIsEmpty(merged)) drafts.delete(path);
      else drafts.set(path, merged);
    }
    refreshDraftUi();
  }

  /** The drafts backing the current selection, in selection order. */
  function draftsForSelection() {
    return selection.paths.map((path) => drafts.get(path) || S.EMPTY_DRAFT);
  }

  /**
   * Builds one edit per selected photo, from that photo's own draft diffed
   * against that photo's own metadata.
   *
   * Per file rather than one edit for the selection, because two photos can
   * now hold different drafts. The baseline comes from current metadata every
   * time — a draft never carries one, so a file that changed on disk is
   * diffed against what it actually holds now.
   */
  function editForPath(path) {
    const entry = metadataCache.get(path);
    if (!entry) return null;
    const draft = drafts.get(path);
    if (!draft) return null;
    const baseline = S.baselineFor([entry]);
    const edit = S.buildEdit(
      draft.pending,
      baseline,
      draft.gpsPending,
      baseline.gps,
      draft.tagPending
    );
    if (S.editIsEmpty(edit)) return null;
    return { path, name: S.basename(entry.SourceFile || path), edit, baseline, tagBaseline: entry };
  }

  function collectEdits() {
    return selection.paths.map(editForPath).filter(Boolean);
  }

  /**
   * Badges the tiles whose drafts would actually write something.
   *
   * Presence of a draft is not enough. Typing a value and deleting it again
   * leaves the field staged as "" — which for a photo that never had one is a
   * change to nothing, and buildEdit correctly emits no edit for it. Badging on
   * the raw draft would mark that photo as having unsaved work for the rest of
   * the session, and the count in the footer would disagree with the badge.
   *
   * A photo whose metadata has not been read yet is badged on the draft alone:
   * there is nothing to diff against, and a badge that appears slightly early
   * is better than one that appears only after the file is clicked.
   */
  function refreshDraftUi() {
    const marked = [];
    for (const path of drafts.keys()) {
      if (!metadataCache.has(path) || editForPath(path)) marked.push(path);
    }
    grid.setDraftPaths(marked);
    publishDirtyState(marked.length);
  }

  /**
   * Tells the shell whether closing the window would throw work away.
   *
   * Derived from the same list the badges are, rather than from `drafts.size`,
   * so the three answers cannot drift apart: a field typed and then cleared
   * again leaves a draft behind that writes nothing, and prompting about it
   * would be a confirmation the user cannot make sense of — nothing on screen
   * would be marked.
   *
   * The count goes with the flag because the dialog is worth being specific in.
   * "You have unsaved changes" is a sentence people click through; naming the
   * number of photos is the part that makes someone stop.
   */
  function publishDirtyState(count) {
    try {
      window.NativeAPI.setDirty(count > 0, count);
    } catch (_) {
      /* A shell without a close guard still edits photos perfectly well. */
    }
  }

  /**
   * What the pending bar reports: changes staged on the selection, and how
   * many other photos are holding some.
   *
   * `here` is counted from the per-file edits, so it is right even when the
   * selection's drafts disagree and the panel's own merged edit is empty.
   * Apply writes exactly these.
   */
  function draftCounts() {
    let here = 0;
    for (const group of collectEdits()) here += S.countChanges(group.edit);
    const selected = new Set(selection.paths);
    let elsewhere = 0;
    for (const path of drafts.keys()) {
      if (selected.has(path)) continue;
      // Same rule as the badge, so the two can never disagree.
      if (!metadataCache.has(path) || editForPath(path)) elsewhere += 1;
    }
    return { here, elsewhere };
  }

  /**
   * Writes the selection's drafts, one edit per photo.
   *
   * Per file rather than one edit fanned across the selection, and in a single
   * call rather than one per distinct edit — `UndoBatch::begin` clears the
   * previous batch, so applying in several calls would leave only the last
   * one undoable. Five photos edited, two restorable.
   */
  async function applyEdit() {
    const groups = collectEdits();
    if (!groups.length) return;

    setStatus(groups.length === 1 ? 'Writing…' : `Writing ${groups.length} photos…`);
    try {
      const outcome = await window.NativeAPI.applyEdits(
        groups.map((group) => [group.path, group.edit])
      );
      // Those files on disk have changed, so every cached read of them is
      // stale — including the previews, since a write replaces the file.
      for (const group of groups) metadataCache.delete(group.path);
      clearAppliedDrafts(groups, outcome);
      invalidatePreviews();
      await refreshPanel();
      await refreshUndo();
      reportBatch(outcome, groups.length);
    } catch (error) {
      // Pre-flight runs before anything is written, so an error here means
      // nothing changed at all. Say so, rather than leaving the user unsure
      // whether some of their photos were modified — and keep every draft,
      // because none of them were saved.
      setStatus(`Nothing was changed. ${error.message || error}`, true);
    }
  }

  /**
   * Drops the drafts that were actually written, and only those.
   *
   * A batch reports per file, so a run where three of fifty fail leaves those
   * three photos still holding their edits — badged, and ready to retry.
   * Clearing everything would quietly discard work the app had just said it
   * could not save.
   */
  function clearAppliedDrafts(groups, outcome) {
    const failed = new Set(
      ((outcome && outcome.results) || [])
        .filter((result) => !result.ok)
        .map((result) => S.normalisePath(result.path))
    );
    for (const group of groups) {
      if (failed.has(S.normalisePath(group.path))) continue;
      drafts.delete(group.path);
    }
    refreshDraftUi();
    panel.refreshCounts();
  }

  function reportBatch(outcome, requested) {
    if (!outcome) return;
    const { succeeded = 0, failed = 0, results = [] } = outcome;
    if (failed === 0) {
      const warned = results.filter((r) => (r.warnings || []).length).length;
      let message = succeeded === 1 ? 'Saved' : `Saved ${succeeded} photos`;
      if (warned) message += ` (${warned} with warnings)`;
      if (outcome.undo_unavailable) message += ` · ${outcome.undo_unavailable}`;
      setStatus(message);
      return;
    }
    // Never round a partial result to "done" or "failed". Name the files that
    // did not make it, so the user knows exactly what to look at.
    const failures = results.filter((r) => !r.ok);
    const names = failures
      .map((r) => S.basename(r.path))
      .slice(0, 3)
      .join(', ');
    const more = failed > 3 ? ` and ${failed - 3} more` : '';
    // The reason matters more than the names. Without it "Saved 0 of 12" is a
    // dead end — there is nothing the user can do with it and nothing they can
    // report. One reason goes in the status bar; the full per-file text goes
    // behind Details, because an ExifTool error does not fit on one line.
    const reason = (failures.find((r) => r.error) || {}).error || '';
    setStatus(
      `Saved ${succeeded} of ${requested}. Failed: ${names}${more}. ` +
        `Those files were left unchanged.` +
        (reason ? ` ${firstLine(reason)}` : ''),
      true
    );
    showFailureReport(failures);
  }

  /* ── Failure detail ──────────────────────────────────────────────────────
     A per-file report someone can read and paste into a bug. Everything here
     is already in the outcome; it was simply being thrown away.            */

  function firstLine(text) {
    const line = String(text).split('\n')[0].trim();
    return line.length > 140 ? `${line.slice(0, 137)}…` : line;
  }

  function showFailureReport(failures) {
    const button = document.getElementById('status-details');
    if (!failures.length) {
      button.hidden = true;
      return;
    }
    const body = failures
      .map((r) => `${r.path}\n    ${r.error || 'no reason was reported'}`)
      .join('\n\n');
    document.getElementById('report-body').value =
      `${failures.length} file(s) were not changed.\n\n${body}\n`;
    button.hidden = false;
  }

  async function refreshUndo() {
    try {
      el.undo.hidden = !(await window.NativeAPI.undoAvailable());
    } catch (_) {
      el.undo.hidden = true;
    }
  }

  async function undoLast() {
    setStatus('Restoring…');
    try {
      const outcome = await window.NativeAPI.undoLast();
      metadataCache.clear();
      invalidatePreviews();
      await refreshPanel();
      await refreshUndo();
      if (outcome.failed && outcome.failed.length) {
        setStatus(
          `Restored ${outcome.restored}, but ${outcome.failed.length} could not be: ` +
            outcome.failed[0],
          true
        );
      } else {
        setStatus(
          outcome.restored === 1
            ? 'Restored the previous version'
            : `Restored ${outcome.restored} photos`
        );
      }
    } catch (error) {
      setStatus(`Could not undo: ${error.message || error}`, true);
    }
  }

  /** A location the user has clicked but not yet applied. */
  let pendingPosition = null;

  const map = window.ExifMap.createMap({
    container: document.getElementById('map'),
    onPick: (position) => stagePosition(position),
    setStatus: (message, isError) => setStatus(message, isError),
  });

  function selectedEntries() {
    return selection.paths.map((p) => metadataCache.get(p)).filter(Boolean);
  }

  function renderMap() {
    map.render(window.ExifMap.markersFor(selectedEntries()), pendingPosition);
  }

  /**
   * Puts a position on the map without writing it.
   *
   * Shared by the paste box, a map click, and the Location field on the Edit
   * tab, so a coordinate arrives at the same place however the user supplied
   * it — and is always visible before it reaches a file.
   */
  function stagePosition(position, note) {
    pendingPosition = position;
    document.getElementById('map-hint').textContent = position
      ? `${S.formatPosition(position)} — ${note || 'not saved yet.'}`
      : 'Click the map to set a location for the selection.';
    renderMap();
    showMapApply();
  }

  function showMapApply() {
    const button = document.getElementById('map-apply');
    const count = selection.paths.length;
    button.hidden = !pendingPosition || count === 0;
    button.textContent =
      count === 1 ? 'Set this location' : `Set this location on ${count} photos`;
  }

  async function applyMapPosition() {
    if (!pendingPosition || !selection.paths.length) return;
    const edit = { gps: { op: 'set', position: pendingPosition } };
    try {
      setStatus(`Writing the location to ${selection.paths.length} photos…`);
      const outcome = await window.NativeAPI.applyEdit(selection.paths, edit);
      pendingPosition = null;
      pasteBox.value = '';
      document.getElementById('map-hint').textContent =
        'Click the map to set a location for the selection.';
      for (const path of selection.paths) metadataCache.delete(path);
      invalidatePreviews();
      await refreshPanel();
      await refreshUndo();
      reportBatch(outcome, selection.paths.length);
    } catch (error) {
      setStatus(`Nothing was changed. ${error.message || error}`, true);
    }
  }

  /** A modal yes/no, for actions with no pending-changes review to guard them. */
  function askConfirm(question, okLabel) {
    return new Promise((resolve) => {
      const dialog = document.getElementById('confirm-dialog');
      document.getElementById('confirm-body').textContent = question;
      const ok = document.getElementById('confirm-ok');
      ok.textContent = okLabel || 'OK';
      const finish = (answer) => {
        ok.removeEventListener('click', onOk);
        dialog.removeEventListener('close', onClose);
        resolve(answer);
      };
      const onOk = () => {
        dialog.close();
        finish(true);
      };
      const onClose = () => finish(false);
      ok.addEventListener('click', onOk);
      dialog.addEventListener('close', onClose);
      dialog.showModal();
    });
  }

  const tools = window.ExifTools.createTools({
    container: document.getElementById('tools'),
    getSelection: () => ({ paths: selection.paths, entries: selectedEntries() }),
    onApplied: (outcome, count) => {
      for (const path of selection.paths) metadataCache.delete(path);
      invalidatePreviews();
      refreshPanel();
      refreshUndo();
      reportBatch(outcome, count);
    },
    setStatus: (message, isError) => setStatus(message, isError),
    confirm: askConfirm,
  });

  /**
   * The CSV export.
   *
   * Reads live, like the geotag panel: the dialog is filled in when it opens,
   * from whatever is selected and whatever the filter is showing at that
   * moment. Nothing here touches `metadataCache` — see export.js for why an
   * export deliberately does not populate it.
   */
  const csvExport = window.ExifExport.createExport({
    container: document.getElementById('export'),
    dialog: document.getElementById('export-dialog'),
    scopeBox: document.getElementById('export-scope'),
    columnsBox: document.getElementById('export-columns'),
    protectBox: document.getElementById('export-protect'),
    dialogCancel: document.getElementById('export-cancel'),
    dialogConfirm: document.getElementById('export-confirm'),
    getScopes: () => {
      const picked = new Set(selection.paths);
      return {
        folder: openFolder,
        // Grid order, not click order: a CSV is read against the folder it
        // came from, and the order photos happened to be selected in is not
        // an order anyone can check it against.
        selected: allEntries.filter((entry) => picked.has(entry.path)),
        visible: visibleEntries,
        all: allEntries,
      };
    },
    setStatus: (message, isError) => setStatus(message, isError),
  });

  const geotag = window.ExifGeotag.createGeotag({
    container: document.getElementById('geotag'),
    // Read live rather than captured: the selection changes underneath.
    getSelection: () => ({
      paths: selection.paths,
      entries: selection.paths.map((p) => metadataCache.get(p)).filter(Boolean),
    }),
    onApplied: (outcome, count) => {
      for (const path of selection.paths) metadataCache.delete(path);
      invalidatePreviews();
      refreshPanel();
      refreshUndo();
      reportBatch(outcome, count);
    },
    setStatus: (message, isError) => setStatus(message, isError),
  });

  const grid = window.ExifGrid.createGrid({
    scroller: el.scroller,
    sizer: el.sizer,
    onSelect: handleSelect,
    onActivate: openPreview,
  });

  // The grid reflows itself: its ResizeObserver sees the scroller change width
  // and relays out the tiles it already has, without discarding their images.
  // The map is the one thing that cannot notice on its own — Leaflet caches
  // the container size and draws to a stale one until told otherwise.
  window.ExifDivider.createDivider({
    divider: document.getElementById('divider'),
    onResize: () => map.refreshSize(),
  });

  /* ── Thumbnail size ───────────────────────────────────────────────────────
     Discrete steps, remembered between launches. The grid owns the range; this
     only drives it and keeps the buttons' disabled state honest.            */

  const thumbSmaller = document.getElementById('thumb-smaller');
  const thumbLarger = document.getElementById('thumb-larger');

  function refreshThumbButtons(size) {
    const sizes = grid.tileSizes();
    thumbSmaller.disabled = size <= sizes[0];
    thumbLarger.disabled = size >= sizes[sizes.length - 1];
  }

  function stepThumbs(delta) {
    const size = grid.stepTileSize(delta);
    window.ExifPrefs.writeNumber(window.ExifPrefs.KEY_THUMB_SIZE, size);
    refreshThumbButtons(size);
  }

  thumbSmaller.addEventListener('click', () => stepThumbs(-1));
  thumbLarger.addEventListener('click', () => stepThumbs(1));

  // Restored before any folder is open, so the first render is already at the
  // size the user chose rather than snapping a moment later.
  refreshThumbButtons(
    grid.setTileSize(
      window.ExifPrefs.readNumber(window.ExifPrefs.KEY_THUMB_SIZE, grid.tileSize())
    )
  );

  /* ── Preview mode ─────────────────────────────────────────────────────────
     A mode of the main area, not an overlay: the panel stays live so metadata
     is still editable while looking at the photo. It shares the grid's preview
     cache, so moving between the two views never re-extracts anything.      */

  const preview = window.ExifPreview.createPreview({
    container: document.getElementById('preview'),
    stage: document.getElementById('preview-stage'),
    image: document.getElementById('preview-image'),
    note: document.getElementById('preview-note'),
    zoomLabel: document.getElementById('preview-zoom'),
    filmstrip: document.getElementById('filmstrip'),
    filmstripSizer: document.getElementById('filmstrip-sizer'),
    cache: grid.cache,
    // Never sets the selection itself: routing through handleSelect is what
    // keeps the panel, the map and the tools tab following the filmstrip.
    onSelect: (path) => handleSelect(path, {}),
    setStatus,
    onClose: exitPreview,
  });

  /** Whether the app believes it is in preview mode. See exitPreview. */
  let previewMode = false;

  /**
   * Puts the toolbar into one mode or the other.
   *
   * One button carries the state rather than two existing: it says what
   * pressing it will do, which is also the only thing that says which view is
   * on screen. The size buttons go away entirely while previewing — they
   * resize a grid that is not visible, and disabling them would leave a dead
   * control sitting there instead of the space.
   */
  function setPreviewChrome(on) {
    el.thumbSize.hidden = on;
    el.previewToggleLabel.textContent = on ? 'Grid' : 'Preview';
    el.previewToggleIcon.className = `icon ${on ? 'icon-table' : 'icon-image'}`;
    el.previewToggle.title = on
      ? 'Back to the grid (Esc)'
      : 'Preview the selected photo (Enter)';
  }

  function openPreview(path) {
    if (!visibleEntries.length) return;
    const target = path || selection.paths[0] || visibleEntries[0].path;
    previewMode = true;
    // Free the tiles: the grid is not visible, and its images are all cached,
    // so coming back is a paint rather than a round of extractions.
    grid.unmountAll();
    el.scroller.hidden = true;
    preview.open(target);
    setPreviewChrome(true);
    if (target !== selection.paths[0]) handleSelect(target, {});
  }

  /**
   * Restores the grid view. Safe to call twice, which is the point.
   *
   * Preview mode can end without anyone pressing anything: filtering the
   * previewed photo away leaves `preview.setEntries` with nothing to show, and
   * it closes itself. That path knows nothing about the scroller, the grid's
   * tiles or the toolbar — all of which live here — so it reports back through
   * `onClose` and lands in this same function. Without the guard the two would
   * close each other; without the callback the app was left with the preview
   * hidden, the grid *also* hidden, and a blank window.
   */
  function exitPreview() {
    if (!previewMode) return;
    previewMode = false;
    // Still valid after close: preview.js keeps its current path, so the grid
    // lands on the photo that was on screen either way.
    const landOn = preview.current();
    if (preview.isOpen()) preview.close();
    el.scroller.hidden = false;
    setPreviewChrome(false);
    grid.remount();
    if (landOn) grid.scrollToPath(landOn);
    el.scroller.focus();
    setStatus('Ready');
  }

  function togglePreview() {
    if (previewMode) exitPreview();
    else openPreview(selection.paths[0]);
  }

  /**
   * Drops every cached picture of a file that has just changed on disk.
   *
   * A write replaces the file, so a thumbnail extracted from it — and the
   * photo currently on the preview stage — are both of a version that no
   * longer exists. Clearing the cache alone is not enough: eviction repaints
   * the tiles, but the stage holds its own `<img>` and would go on showing the
   * pre-edit photo until the user navigated away and back.
   */
  function invalidatePreviews() {
    grid.clearPreviewCache();
    preview.refresh();
    // The decoder remembers which files had no usable thumbnail item, and a
    // write makes that answer stale along with everything else. The disk cache
    // needs no help — its key carries the modification time.
    if (window.ExifHeic) window.ExifHeic.forget();
  }

  function setStatus(message, isError) {
    el.statusText.textContent = message;
    el.status.classList.toggle('error', Boolean(isError));
    // Any new status supersedes the last failure, so the Details button must
    // not outlive the message it belongs to. `reportBatch` re-shows it
    // immediately afterwards when there is something to show.
    document.getElementById('status-details').hidden = true;
  }

  function updateCount() {
    if (!allEntries.length) {
      el.count.textContent = '';
      return;
    }
    const shown =
      visibleEntries.length === allEntries.length
        ? `${allEntries.length} photos`
        : `${visibleEntries.length} of ${allEntries.length} photos`;
    el.count.innerHTML =
      selection.paths.length > 0
        ? `${shown} · <strong>${selection.paths.length} selected</strong>`
        : shown;
  }

  function applyFilter() {
    visibleEntries = S.filterEntries(allEntries, el.filter.value);
    grid.setEntries(visibleEntries);
    // The filmstrip shows what the grid shows. Given the same list it will
    // close preview mode if the photo being previewed has just been filtered
    // away, rather than leaving a photo on screen that is no longer in view.
    preview.setEntries(visibleEntries);
    // A file filtered out of view must not stay selected: a later batch edit
    // would apply to something the user cannot see.
    selection = S.pruneSelection(selection, visibleEntries.map((e) => e.path));
    grid.setSelection(selection.paths);
    el.previewToggle.disabled = visibleEntries.length === 0;
    updateCount();
    refreshPanel();
  }

  function handleSelect(path, modifiers) {
    // Before the selection moves: whatever is in the panel belongs to the
    // photos that are still selected right now. This is the moment the old
    // code threw it away.
    captureDrafts();
    const ordered = visibleEntries.map((e) => e.path);
    if (modifiers.range) {
      selection = S.selectRange(selection, path, ordered);
    } else if (modifiers.toggle) {
      selection = S.toggle(selection, path);
    } else {
      selection = S.selectOnly(selection, path);
    }
    grid.setSelection(selection.paths);
    // Preview follows the selection wherever it came from — a filmstrip click,
    // an arrow key, or a tile in the grid before preview was ever opened.
    preview.setCurrent(selection.paths.length === 1 ? path : null);
    updateCount();
    refreshPanel();
  }

  async function refreshPanel() {
    const paths = selection.paths;
    if (!paths.length) {
      panel.clear();
      refreshDraftUi();
      geotag.refresh();
      tools.refresh();
      csvExport.refresh();
      renderMap();
      showMapApply();
      return;
    }

    const missing = paths.filter((p) => !metadataCache.has(p));
    if (!missing.length) {
      panel.show(paths.map((p) => metadataCache.get(p)), draftsForSelection());
      geotag.refresh();
      tools.refresh();
      csvExport.refresh();
      renderMap();
      showMapApply();
      return;
    }

    const token = ++readToken;
    panel.loading(paths.length);
    try {
      const results = await window.NativeAPI.readMetadata(missing);
      // Cache under the path we *asked* for, not under the SourceFile that
      // came back. ExifTool reports SourceFile as its own rendering of the
      // argument — on Windows it rewrites every separator to a forward slash,
      // so `C:\photos\a.jpg` returns as `C:/photos/a.jpg`. A cache keyed on
      // that can never be hit by a lookup keyed on the entry path, and the
      // reads that have no fallback (selectedEntries, the geotag selection)
      // silently see nothing. On Linux the two strings are identical, which is
      // why it has never shown.
      //
      // Paired by normalised name rather than by position: a file ExifTool
      // cannot read is *omitted* from the array rather than returned as null,
      // which shifts every later index. Storing one photo's tags under another
      // photo's path is the failure that writes the wrong values to the wrong
      // files, so an entry that matches nothing is dropped rather than guessed.
      const requestedBy = new Map(missing.map((p) => [S.normalisePath(p), p]));
      for (const entry of results || []) {
        const requested = entry && requestedBy.get(S.normalisePath(entry.SourceFile));
        if (requested) metadataCache.set(requested, entry);
      }
      // The selection may have moved on while this read was in flight.
      if (token !== readToken) return;
      const entries = paths.map((p) => metadataCache.get(p)).filter(Boolean);
      panel.show(entries, draftsForSelection());
      geotag.refresh();
      tools.refresh();
      csvExport.refresh();
      renderMap();
      showMapApply();
    } catch (error) {
      if (token !== readToken) return;
      setStatus(`Could not read metadata: ${error.message || error}`, true);
      panel.clear();
    }
  }

  async function loadFolder(path) {
    setStatus('Scanning folder…');
    // The photo on the stage belongs to the folder being left behind. Closing
    // here rather than letting setEntries do it means the grid is remounted
    // before the new list arrives, instead of after.
    exitPreview();
    // Drafts are keyed by path and describe photos in the folder being left.
    // They survive filtering and refreshing, but not this.
    drafts.clear();
    // Immediately, rather than letting the next selection do it: an empty
    // folder never selects anything, and a folder that fails to open returns
    // early. Either would otherwise leave the shell still believing there is
    // unsaved work and prompting about it on close.
    refreshDraftUi();
    try {
      const entries = await window.NativeAPI.openLibrary(path);
      // The Rust side speaks snake_case; the frontend speaks camelCase.
      allEntries = entries.map((e) => ({
        path: e.path,
        name: e.name,
        size: e.size,
        mtime: e.mtime,
        needsPreview: e.needs_preview,
      }));
      metadataCache.clear();
      invalidatePreviews();
      selection = S.createSelection();

      el.emptyState.hidden = allEntries.length > 0;
      if (!allEntries.length) {
        el.emptyState.querySelector('h2').textContent = 'No photos here';
        el.emptyState.querySelector('p').textContent =
          'That folder has no JPEG, HEIC, PNG, TIFF or WebP files in it.';
      }

      el.filter.disabled = false;
      el.rescan.disabled = false;
      openFolder = path;
      applyFilter();

      // Land on the first photo rather than an empty panel. Nothing is written
      // without an explicit Apply, so a selection costs nothing.
      if (visibleEntries.length) {
        handleSelect(visibleEntries[0].path, {});
      }
      await refreshUndo();
      setStatus(`${allEntries.length} photos in ${path}`);
    } catch (error) {
      setStatus(`Could not open folder: ${error.message || error}`, true);
    }
  }

  /* ── Events ───────────────────────────────────────────────────────────── */

  async function chooseFolder() {
    try {
      const picked = await window.NativeAPI.chooseFolder();
      if (picked) await loadFolder(picked);
    } catch (error) {
      setStatus(`Could not open the folder picker: ${error.message || error}`, true);
    }
  }

  el.openFolder.addEventListener('click', chooseFolder);
  el.emptyState
    .querySelector('[data-action="open-folder"]')
    .addEventListener('click', chooseFolder);

  el.rescan.addEventListener('click', async () => {
    setStatus('Rescanning…');
    try {
      const entries = await window.NativeAPI.rescanLibrary();
      allEntries = entries.map((e) => ({
        path: e.path,
        name: e.name,
        size: e.size,
        mtime: e.mtime,
        needsPreview: e.needs_preview,
      }));
      // Files may have changed on disk since the last read; a stale tag object
      // would show the user metadata that is no longer there.
      metadataCache.clear();
      invalidatePreviews();
      applyFilter();
      setStatus(`${allEntries.length} photos`);
    } catch (error) {
      setStatus(`Rescan failed: ${error.message || error}`, true);
    }
  });

  el.undo.addEventListener('click', undoLast);
  document.getElementById('map-apply').addEventListener('click', applyMapPosition);

  // Paste from Google Maps, OpenStreetMap, Apple or Bing — or a bare pair of
  // numbers. Shown on the map immediately; still nothing written until Apply.
  const pasteBox = document.getElementById('map-paste');
  pasteBox.addEventListener('input', () => {
    const text = pasteBox.value.trim();
    if (!text) {
      pasteBox.classList.remove('invalid');
      stagePosition(null);
      return;
    }
    const parsed = S.parseCoordinates(text);
    if (!parsed) {
      // Refused rather than guessed: a coordinate the app is unsure about
      // would place the photo somewhere wrong and look deliberate.
      pasteBox.classList.add('invalid');
      document.getElementById('map-hint').textContent =
        'That is not a coordinate or map link the app can read.';
      return;
    }
    pasteBox.classList.remove('invalid');
    stagePosition(parsed, 'pasted — not saved yet.');
  });
  document
    .getElementById('confirm-cancel')
    .addEventListener('click', () => document.getElementById('confirm-dialog').close());

  document.getElementById('status-details').addEventListener('click', () => {
    const dialog = document.getElementById('report-dialog');
    dialog.showModal();
    // Pre-selected, so Ctrl+C is the only thing left to do to report it.
    document.getElementById('report-body').select();
  });
  document
    .getElementById('report-close')
    .addEventListener('click', () => document.getElementById('report-dialog').close());

  el.filter.addEventListener('input', applyFilter);

  el.scroller.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'a') {
      event.preventDefault();
      selection = S.selectAll(visibleEntries.map((e) => e.path));
      grid.setSelection(selection.paths);
      updateCount();
      refreshPanel();
      return;
    }
    if (event.key === 'Enter' && selection.paths.length) {
      event.preventDefault();
      openPreview(selection.paths[0]);
    }
  });

  el.previewToggle.addEventListener('click', togglePreview);
  document.getElementById('preview-fit').addEventListener('click', () => preview.fit());
  document.getElementById('preview-actual').addEventListener('click', () => preview.actualSize());
  document.getElementById('preview-prev').addEventListener('click', () => preview.previous());
  document.getElementById('preview-next').addEventListener('click', () => preview.next());

  /**
   * True when a keystroke belongs to something other than the photo view.
   *
   * Two cases, and missing either one is the sort of bug that only shows up
   * once somebody is halfway through typing: a focused text field, where every
   * arrow key is a cursor movement, and an open dialog, where the app has five
   * of them and Esc already means "close this dialog".
   */
  function keystrokeIsSpokenFor(event) {
    const target = event.target;
    if (target && target.closest && target.closest('input, textarea, select')) return true;
    return Boolean(document.querySelector('dialog[open]'));
  }

  document.addEventListener('keydown', (event) => {
    if (!preview.isOpen() || keystrokeIsSpokenFor(event)) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    switch (event.key) {
      case 'Escape':
        exitPreview();
        break;
      case 'ArrowLeft':
        preview.previous();
        break;
      case 'ArrowRight':
        preview.next();
        break;
      case '0':
        preview.fit();
        break;
      case '1':
        preview.actualSize();
        break;
      case '+':
      case '=':
        preview.zoomIn();
        break;
      case '-':
        preview.zoomOut();
        break;
      default:
        return;
    }
    event.preventDefault();
  });

  /** Reports what the webview can actually render maps with. */
  function probeRenderer() {
    let detail = 'webgl: unavailable';
    try {
      const canvas = document.createElement('canvas');
      const gl =
        canvas.getContext('webgl2') ||
        canvas.getContext('webgl') ||
        canvas.getContext('experimental-webgl');
      if (gl) {
        const info = gl.getExtension('WEBGL_debug_renderer_info');
        const renderer = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown';
        const version = gl.getParameter(gl.VERSION);
        detail = `webgl: ok — ${version} — ${renderer}`;
      }
    } catch (error) {
      detail = `webgl: threw — ${error.message || error}`;
    }
    try {
      window.NativeAPI.reportRenderer(detail);
    } catch (_) { /* diagnostic only */ }
  }

  /* ── Boot ─────────────────────────────────────────────────────────────── */

  // The in-page half of the close guard. Covers a reload — Ctrl+R, or a
  // devtools reload during development — which never reaches the shell's own
  // window-close handling. The shells guard the actual close, because neither
  // routes it through `beforeunload`: Electron needs the window's `close`
  // event and Tauri needs `CloseRequested`.
  window.addEventListener('beforeunload', (event) => {
    const { here, elsewhere } = draftCounts();
    if (here + elsewhere === 0) return;
    event.preventDefault();
    // Set for the browsers that still require it; the text is never shown.
    event.returnValue = '';
  });

  (async function boot() {
    // Any desktop shell will do. Testing for one named shell is how the
    // Electron build ended up reporting itself as a browser.
    if (window.NativeAPI.ENV === 'web') {
      setStatus('Running outside the desktop app — file access is unavailable.', true);
      el.openFolder.disabled = true;
      return;
    }
    try {
      const version = await window.NativeAPI.engineVersion();
      el.engineVersion.textContent = `ExifTool ${version}`;
      setStatus('Ready');
      probeRenderer();
      // Launched with a folder — from a file manager's "Open with", or by
      // dropping a folder on the app.
      const initial = await window.NativeAPI.initialFolder();
      if (initial) await loadFolder(initial);
    } catch (error) {
      // A missing vendor tree is a setup problem, and saying so at launch
      // beats a confusing failure on the first folder the user opens.
      el.engineVersion.textContent = 'ExifTool unavailable';
      setStatus(`Metadata engine unavailable: ${error.message || error}`, true);
      el.openFolder.disabled = true;
    }
  })();
})();
