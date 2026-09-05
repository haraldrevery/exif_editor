/**
 * export.js — the CSV export: the Tools-tab section, its dialog, and the read.
 *
 * The file itself is spelled by `csv.js`, which is pure and tested. What lives
 * here is everything that needs a window: which photos, which columns, and
 * getting the metadata for photos the app has never selected.
 *
 * # Why the read is chunked
 *
 * `readMetadata` fans a whole selection into one ExifTool call, which is right
 * for a selection and wrong for a folder. The engine gives a request 120
 * seconds and *retries once*, so an over-large batch does not fail in two
 * minutes, it fails in four — with the ExifTool session held throughout, which
 * stalls thumbnails and every other read behind it. So an export goes in
 * batches, asking only for the tags its columns need, and reports progress
 * between them.
 *
 * Nothing here writes to the app's metadata cache. The cache is keyed to what
 * the panel is showing and invalidated when a file is written; an export
 * filling it with several thousand partial tag objects would make the Edit
 * panel show blanks for fields those objects never asked for.
 */

(function () {
  'use strict';

  const S = window.ExifState;
  const Csv = window.ExifCsv;

  /**
   * Photos per ExifTool round trip.
   *
   * Small enough that no single request can approach the engine's timeout on a
   * slow disk, large enough that the per-request overhead is nothing next to
   * the reads. Also the progress granularity.
   */
  const CHUNK = 200;

  function createExport({
    container,
    dialog,
    scopeBox,
    columnsBox,
    protectBox,
    dialogCancel,
    dialogConfirm,
    getScopes,
    setStatus,
  }) {
    const el = {};
    /** Set while a read is in flight, so the button can cancel it. */
    let running = false;
    let cancelled = false;

    /* ── The section ─────────────────────────────────────────────────────── */

    function build() {
      const section = document.createElement('section');
      section.className = 'geo-section';
      const heading = document.createElement('h3');
      heading.innerHTML =
        '<span class="icon icon-table" aria-hidden="true"></span>Export a CSV';
      const blurb = document.createElement('p');
      blurb.className = 'field-hint';
      blurb.textContent =
        'One row per photo: file name, title and description, plus whatever ' +
        'else you tick. Nothing is written to your photos.';

      el.open = document.createElement('button');
      el.open.className = 'primary';
      el.open.textContent = 'Export CSV…';
      el.open.addEventListener('click', () => (running ? cancel() : openDialog()));

      section.append(heading, blurb, el.open);
      container.innerHTML = '';
      container.appendChild(section);
    }

    /* ── The dialog ──────────────────────────────────────────────────────── */

    /** Which set of photos each radio stands for, rebuilt every time it opens. */
    let scopes = [];

    function openDialog() {
      const available = getScopes();
      scopes = [
        {
          key: 'selection',
          entries: available.selected,
          label: (n) => (n === 1 ? 'The selected photo' : `The ${n} selected photos`),
        },
        {
          key: 'visible',
          entries: available.visible,
          // Offered only when the filter is actually narrowing something,
          // because otherwise this is the whole folder under a second name.
          // When it *is* narrowing, saying so is the point: a filter left on
          // from an hour ago is exactly what makes an export come out short.
          skip: available.visible.length === available.all.length,
          label: (n) => `The ${n} photos the filter is showing`,
        },
        {
          key: 'folder',
          entries: available.all,
          label: (n) =>
            n === 1 ? 'The 1 photo in this folder' : `All ${n} photos in this folder`,
        },
      ].filter((scope) => scope.entries.length > 0 && !scope.skip);

      buildScopes();
      buildColumns();
      protectBox.checked = readProtect();
      dialog.showModal();
    }

    function buildScopes() {
      scopeBox.innerHTML = '';
      // The largest set that is not the whole folder is the least surprising
      // default: a selection if there is a real one, the filter if it is on.
      const preferred =
        scopes.find((scope) => scope.key === 'selection' && scope.entries.length > 1) ||
        scopes.find((scope) => scope.key === 'visible') ||
        scopes.find((scope) => scope.key === 'folder') ||
        scopes[0];

      for (const scope of scopes) {
        const row = document.createElement('label');
        row.className = 'checkbox-row';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'export-scope';
        radio.value = scope.key;
        radio.checked = scope === preferred;
        const text = document.createElement('span');
        text.textContent = scope.label(scope.entries.length);
        row.append(radio, text);
        scopeBox.appendChild(row);
      }
      if (!scopes.length) {
        const none = document.createElement('p');
        none.className = 'field-hint';
        none.textContent = 'There are no photos to export.';
        scopeBox.appendChild(none);
      }
      dialogConfirm.disabled = !scopes.length;
    }

    function buildColumns() {
      const remembered = readColumns();
      columnsBox.innerHTML = '';
      for (const column of Csv.COLUMNS) {
        const row = document.createElement('label');
        row.className = 'checkbox-row';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.dataset.column = column.key;
        box.checked = column.locked || remembered.includes(column.key);
        // Shown ticked rather than hidden: the first three columns are what
        // the export *is*, and leaving them out of the list would read as
        // though they were not going to be written.
        box.disabled = Boolean(column.locked);
        const text = document.createElement('span');
        text.textContent = column.label;
        row.append(box, text);
        if (column.locked) {
          const always = document.createElement('span');
          always.className = 'column-always';
          always.textContent = 'always';
          row.appendChild(always);
        }
        columnsBox.appendChild(row);
      }
    }

    function chosenScope() {
      const picked = scopeBox.querySelector('input:checked');
      const scope = scopes.find((s) => s.key === (picked && picked.value));
      return scope ? scope.entries : [];
    }

    function chosenColumns() {
      return [...columnsBox.querySelectorAll('input:checked')].map(
        (box) => box.dataset.column
      );
    }

    /* ── Remembering the choice ──────────────────────────────────────────── */

    function readColumns() {
      const raw = window.ExifPrefs.readText(window.ExifPrefs.KEY_EXPORT_COLUMNS, '');
      const known = new Set(Csv.COLUMNS.map((column) => column.key));
      // Filtered against the current column set: a key stored by a later build
      // must not resurrect a column this one does not have.
      return raw.split(',').filter((key) => known.has(key));
    }

    function readProtect() {
      return window.ExifPrefs.readText(window.ExifPrefs.KEY_EXPORT_PROTECT, '1') !== '0';
    }

    function remember(columns, protect) {
      window.ExifPrefs.writeText(window.ExifPrefs.KEY_EXPORT_COLUMNS, columns.join(','));
      window.ExifPrefs.writeText(window.ExifPrefs.KEY_EXPORT_PROTECT, protect ? '1' : '0');
    }

    /* ── Running it ──────────────────────────────────────────────────────── */

    function cancel() {
      cancelled = true;
      setStatus('Stopping the export…');
    }

    function setRunning(on) {
      running = on;
      el.open.textContent = on ? 'Cancel export' : 'Export CSV…';
      el.open.classList.toggle('primary', !on);
    }

    async function run() {
      const entries = chosenScope();
      const columns = chosenColumns();
      const protect = protectBox.checked;
      if (!entries.length) return;
      remember(columns, protect);

      cancelled = false;
      setRunning(true);
      try {
        const tags = Csv.tagsFor(columns);
        const records = [];
        let unreadable = 0;

        for (let start = 0; start < entries.length; start += CHUNK) {
          if (cancelled) {
            setStatus(`Export cancelled after ${records.length} photos.`);
            return;
          }
          const batch = entries.slice(start, start + CHUNK);
          setStatus(
            `Reading metadata… ${Math.min(start + batch.length, entries.length)} of ${entries.length}`
          );
          const results = await window.NativeAPI.readFields(
            batch.map((entry) => entry.path),
            tags
          );
          // Paired by normalised name, never by position. A file ExifTool
          // cannot read is *omitted* from the array rather than returned as a
          // null, which shifts every later index — and a shifted index here
          // puts one photo's caption on another photo's row, in a file whose
          // whole purpose is to be trusted as a record of what is where.
          const byPath = new Map();
          for (const entry of results || []) {
            const source = entry && entry.SourceFile;
            if (source) byPath.set(S.normalisePath(source), entry);
          }
          for (const entry of batch) {
            const tagsForFile = byPath.get(S.normalisePath(entry.path));
            if (!tagsForFile) unreadable += 1;
            // Still a row, even with nothing in it. A photo silently missing
            // from the export is worse than one with empty columns: the count
            // is the first thing anyone checks against the folder.
            records.push({
              name: entry.name,
              path: entry.path,
              size: entry.size,
              tags: tagsForFile || {},
            });
          }
        }

        setStatus('Writing the file…');
        const csv = Csv.buildCsv({ columns, records, protectFormulas: protect });
        const saved = await window.NativeAPI.exportCsv(
          csv,
          Csv.suggestedName(getScopes().folder)
        );
        if (!saved) {
          setStatus('Export cancelled.');
          return;
        }
        const rows = records.length === 1 ? '1 photo' : `${records.length} photos`;
        setStatus(
          `Exported ${rows} to ${saved}.` +
            (unreadable
              ? ` ${unreadable} could not be read and were written with only a file name.`
              : '')
        );
      } catch (error) {
        setStatus(`The export failed. ${error.message || error}`, true);
      } finally {
        setRunning(false);
      }
    }

    dialogCancel.addEventListener('click', () => dialog.close());
    dialogConfirm.addEventListener('click', () => {
      dialog.close();
      run();
    });

    build();

    return {
      refresh() {
        // Only whether there is anything at all to export; the dialog works
        // out the scopes when it opens, from a selection that may have moved
        // since.
        if (running) return;
        el.open.disabled = getScopes().all.length === 0;
      },
    };
  }

  window.ExifExport = { createExport, CHUNK };
})();
