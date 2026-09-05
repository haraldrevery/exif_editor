/**
 * panel.js — the side panel: editable curated fields, and the tag inspector.
 *
 * DOM assembly only. Every decision about what a value should *say*, and what
 * an edit should *do*, lives in state.js where it is unit-tested.
 *
 * Nothing is written as you type. Changes accumulate, the footer shows how
 * many there are, and Apply is the only thing that touches a file — after the
 * review dialog has shown exactly what will change.
 */

(function () {
  'use strict';

  const S = window.ExifState;

  function createPanel({
    tabs,
    panels,
    editHint,
    editFields,
    inspector,
    inspectorFilter,
    footer,
    footerText,
    reviewButton,
    applyButton,
    revertButton,
    dialog,
    dialogBody,
    dialogConfirm,
    dialogCancel,
    tagDialog,
    tagDialogTitle,
    tagDialogHint,
    tagDialogValue,
    tagDialogConfirm,
    tagDialogCancel,
    addTagButton,
    tagPicker,
    tagPickerFilter,
    tagPickerList,
    tagPickerCancel,
    onApply,
    onLoadTags,
    onShowMap,
    onPositionTyped,
    onCollectEdits,
    onRevert,
    onDraftChanged,
    onDraftCounts,
  }) {
    /** One ExifTool tag object per selected file. */
    let current = [];
    /**
     * One draft per selected file, parallel to `current`.
     *
     * Owned by app.js and handed in — see its comment on the drafts map for
     * why the keys live there rather than here.
     */
    let drafts = [];
    /** field key -> raw input value, for fields the user has touched. */
    let pending = {};
    /** undefined = untouched, null = remove, object = a position. */
    let gpsPending;
    /** What each field resolved to before editing, for change detection. */
    let baseline = {};
    let gpsBaseline = null;
    let inspectorQuery = '';
    let editable = false;
    /**
     * Raw tags staged from the All tab.
     * `'EXIF:Artist' -> { op: 'set', value } | { op: 'clear' }`
     *
     * Already-decided operations rather than input strings, unlike `pending`.
     * A curated field diffs what was typed against a resolution to work out
     * whether it is a set, a clear or a no-op; a raw tag has no such baseline
     * and no list flag, so the decision is made where the user makes it.
     */
    let tagPending = {};

    /* ── Tabs ────────────────────────────────────────────────────────────── */

    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        tabs.forEach((t) => t.classList.toggle('active', t === tab));
        panels.forEach((panel) => {
          panel.hidden = panel.dataset.panel !== tab.dataset.tab;
        });
        // Leaflet sizes itself against a container that was hidden when the
        // map was created, so it comes out zero-sized until told otherwise.
        if (tab.dataset.tab === 'map' && onShowMap) onShowMap();
      });
    });

    /* ── Change tracking ─────────────────────────────────────────────────── */

    function currentEdit() {
      return S.buildEdit(pending, baseline, gpsPending, gpsBaseline, tagPending);
    }

    /** The tag values the inspector started from, for the review diff. */
    function tagBaseline() {
      return current.length === 1 ? current[0] : {};
    }

    /**
     * Rebuilds the working state from the selection's drafts.
     *
     * A field every draft agrees on is seeded, so the box shows the typing and
     * `currentEdit` still stages it. A field the drafts *disagree* on is left
     * out: `pending` holds one value for the whole selection and cannot
     * represent two answers, so seeding either one would silently overwrite the
     * other on Apply. The box shows "mixed", each file keeps its own draft, and
     * the per-file apply path writes them separately.
     */
    function seedFromDrafts() {
      pending = {};
      gpsPending = undefined;
      tagPending = {};
      if (!drafts.length) return;

      for (const field of S.FIELDS) {
        if (field.readOnly) continue;
        const resolved = S.resolveDraftField(drafts, field.key);
        if (!resolved || resolved.state === 'mixed') continue;
        pending[field.key] = resolved.state === 'single' ? resolved.value : '';
      }

      // GPS and raw tags are seeded only from a single photo's draft. Merging
      // several files' coordinates, or their per-tag operations, has no
      // meaningful answer — and guessing one would write it to all of them.
      if (drafts.length === 1) {
        gpsPending = drafts[0].gpsPending;
        tagPending = { ...(drafts[0].tagPending || {}) };
      }
    }

    /**
     * Redraws the pending bar, and tells the app the draft moved.
     *
     * Every staging path already funnels through here, so this is the one hook
     * that catches a typed field, a pasted coordinate and a staged raw tag
     * alike. `notify` exists because the app answers by handing back a new
     * other-draft count, which redraws the bar again — without it the two would
     * call each other until the stack ran out.
     */
    function refreshFooter(notify) {
      // **Before the early return below.** The notification means "the draft
      // may have moved", not "the bar is visible", and the app answers it by
      // recounting the drafts held elsewhere. Firing it only when the bar was
      // already showing meant selecting a photo that had no draft of its own
      // never triggered the recount — so an edit left on another photo stayed
      // invisible from here, which is exactly what the count exists to prevent.
      if (notify !== false && onDraftChanged) onDraftChanged();

      // **Counted from the per-file drafts, not from `currentEdit()`.** The
      // panel's own edit is one value for the whole selection and cannot
      // represent two photos with different drafts — it comes back empty for
      // exactly that case, which hid the bar and made Apply unreachable at the
      // moment the user most needed it. The app counts what will actually be
      // written, which is also what Apply then writes.
      const counts = (onDraftCounts && onDraftCounts()) || { here: 0, elsewhere: 0 };
      const count = counts.here;
      const otherDraftCount = counts.elsewhere;

      // The bar also has to appear for drafts held elsewhere, or edits left on
      // other photos are invisible from here.
      footer.hidden = count === 0 && otherDraftCount === 0;
      if (footer.hidden) return;

      // Kept short because the panel can be dragged down to 280px, where a
      // sentence wraps to half a dozen lines and the bar stops looking like a
      // bar. When the selection has no changes of its own there is no point
      // saying so — the only news is what is waiting elsewhere.
      const others =
        otherDraftCount === 1 ? '1 other photo' : `${otherDraftCount} other photos`;
      if (count === 0) {
        footerText.textContent = `${others} with unsaved edits`;
      } else {
        const here = count === 1 ? '1 change, not yet saved' : `${count} changes, not yet saved`;
        footerText.textContent =
          otherDraftCount === 0 ? here : `${here} · ${others}`;
      }
      // Apply only ever writes the selection, so it stays off when the only
      // outstanding work belongs to photos that are not on screen.
      applyButton.disabled = count === 0;
      reviewButton.disabled = count === 0;
    }

    function markPending(key, value) {
      pending[key] = value;
      refreshFooter();
    }

    /* ── Curated fields ──────────────────────────────────────────────────── */

    /**
     * @param resolution what the files hold — always the baseline for diffing.
     * @param draft what the user has typed but not applied, or `null`. When
     *   present it is what the box *shows*; the baseline is still `resolution`,
     *   because an edit is only a change relative to the file.
     */
    function buildField(field, resolution, draft) {
      const wrap = document.createElement('div');
      wrap.className = 'field';

      const label = document.createElement('label');
      label.textContent = field.label;
      label.htmlFor = `field-${field.key}`;
      wrap.appendChild(label);

      // A draft wins the *display*, never the baseline. Showing the file's
      // value for a field the user has typed into would silently discard their
      // typing the moment the panel re-rendered.
      const shown = draft || resolution;
      const described = S.describeField(shown, field);

      if (field.readOnly || !editable) {
        const value = document.createElement('div');
        value.className = 'value';
        if (described.modifier) value.classList.add(described.modifier);
        value.textContent = described.text;
        wrap.appendChild(value);
        return wrap;
      }

      const input =
        field.key === 'description'
          ? document.createElement('textarea')
          : document.createElement('input');
      if (input.tagName === 'TEXTAREA') input.rows = 3;
      else input.type = 'text';
      input.id = `field-${field.key}`;
      input.className = 'value input';

      // The box shows the real value when there is one, and says what it is
      // otherwise. A placeholder rather than a value, so typing replaces
      // nothing the user has to delete first.
      if (shown.state === 'single') {
        input.value = described.text;
      } else {
        input.value = '';
        input.placeholder = shown.state === 'mixed' ? '—— mixed ——' : 'not set';
        if (shown.state === 'mixed') input.classList.add('mixed');
      }
      // Marks the field as carrying unapplied typing, so a restored draft is
      // visibly a draft rather than something already saved.
      if (draft) input.classList.add('drafted');
      if (field.list) {
        input.setAttribute('aria-describedby', `hint-${field.key}`);
      }

      input.addEventListener('input', () => markPending(field.key, input.value));
      wrap.appendChild(input);

      if (field.list) {
        const hint = document.createElement('div');
        hint.className = 'field-hint';
        hint.id = `hint-${field.key}`;
        hint.textContent = 'Separate with commas';
        wrap.appendChild(hint);
      }
      return wrap;
    }

    function buildGpsField(positions) {
      const wrap = document.createElement('div');
      wrap.className = 'field';
      const label = document.createElement('label');
      label.textContent = 'Location';
      label.htmlFor = 'field-gps';
      wrap.appendChild(label);

      const described = S.describePositions(positions);

      if (!editable) {
        const value = document.createElement('div');
        value.className = 'value';
        if (described.modifier) value.classList.add(described.modifier);
        value.textContent = described.text;
        wrap.appendChild(value);
        return wrap;
      }

      const row = document.createElement('div');
      row.className = 'gps-row';

      const input = document.createElement('input');
      input.type = 'text';
      input.id = 'field-gps';
      input.className = 'value input';
      input.value = described.modifier ? '' : described.text;
      input.placeholder = described.modifier === 'mixed' ? '—— mixed ——' : 'not set';

      const status = document.createElement('div');
      status.className = 'field-hint';
      status.textContent = 'Paste coordinates, DMS, or a maps link';

      input.addEventListener('input', () => {
        const text = input.value.trim();
        if (!text) {
          gpsPending = null;
          input.classList.remove('invalid');
          status.textContent = 'Location will be removed';
          refreshFooter();
          return;
        }
        const parsed = S.parseCoordinates(text);
        if (!parsed) {
          // Refused rather than guessed. A coordinate the app is unsure about
          // would place the photo somewhere wrong and look deliberate.
          input.classList.add('invalid');
          status.textContent = 'Not a coordinate the app can read';
          gpsPending = undefined;
          refreshFooter();
          return;
        }
        input.classList.remove('invalid');
        gpsPending = parsed;
        status.textContent = S.formatPosition(parsed);
        // Show it on the map as well, so a coordinate typed here is visible
        // before it is written rather than only after.
        if (onPositionTyped) onPositionTyped(parsed);
        refreshFooter();
      });

      row.appendChild(input);
      wrap.append(row, status);
      return wrap;
    }

    function renderFields(entries) {
      editFields.innerHTML = '';
      // Always from the files themselves, never from a draft — this is what an
      // edit is diffed against, and diffing against typing would make every
      // field look unchanged.
      baseline = S.baselineFor(entries);
      for (const field of S.FIELDS) {
        editFields.appendChild(
          buildField(field, baseline[field.key], S.resolveDraftField(drafts, field.key))
        );
      }
      const positions = entries.map((e) => S.positionOf(e));
      // A three-state resolution, like every other field: a mixed selection is
      // not the same as one with no locations at all, and clearing must work
      // on both.
      gpsBaseline = baseline.gps;
      editFields.appendChild(buildGpsField(positions));

      if (entries.length > 1) {
        const note = document.createElement('div');
        note.className = 'readonly-note';
        note.textContent =
          `Editing ${entries.length} photos. A field you type into is written ` +
          `to all of them; a field you leave alone is not touched.`;
        editFields.appendChild(note);
      }
    }

    /* ── Review and apply ────────────────────────────────────────────────── */

    function buildDiffTable(rows) {
      const table = document.createElement('div');
      table.className = 'diff';
      for (const row of rows) {
        const line = document.createElement('div');
        line.className = 'diff-row';
        const label = document.createElement('div');
        label.className = 'diff-label';
        label.textContent = row.label;
        const from = document.createElement('div');
        from.className = 'diff-from';
        from.textContent = row.from;
        const arrow = document.createElement('div');
        arrow.className = 'diff-arrow';
        arrow.textContent = '→';
        const to = document.createElement('div');
        to.className = 'diff-to';
        to.textContent = row.to;
        if (row.to === 'removed') to.classList.add('removed');
        line.append(label, from, arrow, to);
        table.appendChild(line);
      }
      return table;
    }

    /** Two diffs are the same change when every row matches. */
    function sameRows(a, b) {
      return (
        a.length === b.length &&
        a.every((row, i) => row.label === b[i].label && row.from === b[i].from && row.to === b[i].to)
      );
    }

    /**
     * Shows exactly what Apply will write, before it writes anything.
     *
     * Drafts are per file, so a selection can now carry *different* changes for
     * different photos. When they agree this reads as it always has — one diff
     * and a list of the files it lands on. When they disagree the diff is split
     * per file, because a single merged list would describe a write that is not
     * the one about to happen.
     */
    function openReview() {
      const groups = onCollectEdits ? onCollectEdits() : [];
      dialogBody.innerHTML = '';

      const withRows = groups
        .map((group) => ({
          name: group.name,
          rows: S.summariseEdit(group.edit, group.baseline, group.tagBaseline || {}),
        }))
        .filter((group) => group.rows.length);

      if (!withRows.length) {
        const none = document.createElement('p');
        none.className = 'diff-target';
        none.textContent = 'Nothing would be written.';
        dialogBody.appendChild(none);
        dialog.showModal();
        return;
      }

      const uniform = withRows.every((group) => sameRows(group.rows, withRows[0].rows));

      if (uniform) {
        dialogBody.appendChild(buildDiffTable(withRows[0].rows));
        const target = document.createElement('p');
        target.className = 'diff-target';
        if (withRows.length === 1) {
          target.textContent = `Will be written to ${withRows[0].name}`;
        } else {
          // Name them. "Will be written to 34 files" is not enough to check
          // against before overwriting metadata on all of them.
          const names = withRows.map((group) => group.name).filter(Boolean);
          const shown = names.slice(0, 6).join(', ');
          const more = names.length > 6 ? `, and ${names.length - 6} more` : '';
          target.textContent = `Will be written to ${names.length} files: ${shown}${more}`;
        }
        dialogBody.appendChild(target);
      } else {
        for (const group of withRows) {
          const heading = document.createElement('p');
          heading.className = 'diff-file';
          heading.textContent = group.name;
          dialogBody.appendChild(heading);
          dialogBody.appendChild(buildDiffTable(group.rows));
        }
        const target = document.createElement('p');
        target.className = 'diff-target';
        target.textContent =
          `These ${withRows.length} photos have different unsaved edits, ` +
          `and each will be written its own.`;
        dialogBody.appendChild(target);
      }

      dialog.showModal();
    }

    reviewButton.addEventListener('click', openReview);
    dialogCancel.addEventListener('click', () => dialog.close());
    dialogConfirm.addEventListener('click', () => {
      dialog.close();
      // No argument: the selection's edits are per file now, and app.js is what
      // holds the drafts they are built from.
      onApply();
    });
    applyButton.addEventListener('click', () => openReview());
    revertButton.addEventListener('click', () => {
      pending = {};
      gpsPending = undefined;
      tagPending = {};
      // Drops the stored drafts too, or the next render would restore exactly
      // what was just reverted.
      if (onRevert) onRevert();
      drafts = current.map(() => S.EMPTY_DRAFT);
      renderFields(current);
      renderInspector(current);
      refreshFooter();
    });

    /* ── Inspector ───────────────────────────────────────────────────────── */

    function renderInspector(entries) {
      inspector.innerHTML = '';

      if (entries.length !== 1) {
        const hint = document.createElement('div');
        hint.className = 'panel-hint';
        hint.textContent =
          entries.length === 0
            ? 'Select a single photo to see every tag.'
            : `${entries.length} photos selected. Select one to see every tag.`;
        inspector.appendChild(hint);
        return;
      }

      const needle = inspectorQuery.trim().toLowerCase();
      let shown = 0;

      for (const { group, tags } of S.groupTags(entries[0])) {
        const matching = needle
          ? tags.filter(
              (t) =>
                t.name.toLowerCase().includes(needle) ||
                String(t.value).toLowerCase().includes(needle) ||
                group.toLowerCase().includes(needle)
            )
          : tags;
        if (!matching.length) continue;

        const section = document.createElement('div');
        section.className = 'tag-group';
        const heading = document.createElement('h3');
        heading.textContent = `${group} (${matching.length})`;
        section.appendChild(heading);

        for (const tag of matching) {
          section.appendChild(buildTagRow(tag));
          shown += 1;
        }
        inspector.appendChild(section);
      }

      if (!shown) {
        const hint = document.createElement('div');
        hint.className = 'panel-hint';
        hint.textContent = 'No tags match that filter.';
        inspector.appendChild(hint);
      }
    }

    /**
     * One inspector row, showing any change staged against it.
     *
     * The row shows the bare name, since the group is already the section
     * heading, but everything that *acts* on the tag uses `tag.key` — the
     * original, unsplit name. That key is what identifies it in `tagPending`,
     * in the review diff, and in the argument the backend builds.
     */
    function buildTagRow(tag) {
      const full = tag.key;
      const staged = tagPending[full];

      const row = document.createElement('div');
      row.className = 'tag-row';
      row.dataset.tag = full;

      const name = document.createElement('div');
      name.className = 'tag-name';
      name.textContent = tag.name;

      const value = document.createElement('div');
      value.className = 'tag-value';
      // A staged change shows its *new* value, not the one on disk. The
      // inspector is the only place these edits are visible before Apply, so
      // showing the stale value would make a staged change invisible.
      if (staged && staged.op === 'set') {
        row.classList.add('pending');
        value.textContent = Array.isArray(staged.value)
          ? staged.value.join(', ')
          : String(staged.value);
      } else if (staged && staged.op === 'clear') {
        row.classList.add('pending', 'removed');
        value.textContent = S.describeTagValue(tag.value);
      } else {
        value.textContent = S.describeTagValue(tag.value);
      }

      row.append(name, value, buildTagActions(full, tag));
      return row;
    }

    function buildTagActions(full, tag) {
      const reason = S.lockedReason(full);
      const actions = document.createElement('div');
      actions.className = 'tag-actions';

      if (reason || !S.isEditableValue(tag.value)) {
        // Locked rows keep their place and explain themselves. Hiding them
        // would make the All tab an incomplete view of the file, which is the
        // one thing it is for.
        const lock = document.createElement('span');
        lock.className = 'tag-locked';
        lock.textContent = '🔒';
        const why =
          reason || 'binary data, which this app will not edit as text';
        lock.title = `${full} cannot be changed: it is ${why}.`;
        lock.setAttribute('aria-label', lock.title);
        actions.appendChild(lock);
        return actions;
      }

      const edit = document.createElement('button');
      edit.type = 'button';
      edit.dataset.action = 'edit-tag';
      edit.title = `Edit ${full}`;
      edit.setAttribute('aria-label', edit.title);
      edit.innerHTML = '<span class="icon icon-edit-file" aria-hidden="true"></span>';

      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'clear';
      clear.dataset.action = 'clear-tag';
      clear.title = `Remove ${full}`;
      clear.setAttribute('aria-label', clear.title);
      clear.innerHTML = '<span class="icon icon-cross" aria-hidden="true"></span>';

      actions.append(edit, clear);
      return actions;
    }

    // One delegated listener rather than two per row. Everywhere else in this
    // file a listener is attached per element, but the inspector tears down
    // and rebuilds its entire tree on every filter keystroke — several hundred
    // rows, so a thousand listeners per keypress.
    inspector.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const row = button.closest('.tag-row');
      if (!row || !row.dataset.tag) return;
      const full = row.dataset.tag;

      if (button.dataset.action === 'clear-tag') {
        stageTag(full, { op: 'clear' });
        return;
      }
      openTagDialog(full, currentTagValue(full));
    });

    /** The value on disk for one tag, straight from the last read. */
    function currentTagValue(full) {
      return current.length === 1 ? current[0][full] : undefined;
    }

    function stageTag(full, staged) {
      // Re-staging a tag replaces the previous decision rather than stacking.
      if (staged) tagPending[full] = staged;
      else delete tagPending[full];
      refreshFooter();
      rerenderInspector();
    }

    /**
     * Redraws the tag list, holding the reader's place.
     *
     * `renderInspector` rebuilds the whole tree, so without this, editing a tag
     * near the bottom of a few hundred rows jumps back to the top of the file.
     */
    function rerenderInspector() {
      const scroller = inspector.parentElement;
      const y = scroller ? scroller.scrollTop : 0;
      renderInspector(current);
      if (scroller) scroller.scrollTop = y;
    }

    inspectorFilter.addEventListener('input', () => {
      inspectorQuery = inspectorFilter.value;
      renderInspector(current);
    });

    /* ── The tag dialog ──────────────────────────────────────────────────────
       A dialog rather than an inline input because `renderInspector` rebuilds
       the whole tree on every filter keystroke, which would discard a
       half-typed value mid-edit.                                            */

    /** The tag the dialog is currently editing. */
    let tagBeingEdited = null;

    function openTagDialog(full, value) {
      tagBeingEdited = full;
      tagDialogTitle.textContent = full;

      const staged = tagPending[full];
      const isList = Array.isArray(staged && staged.op === 'set' ? staged.value : value);
      tagDialogHint.textContent = isList
        ? 'Several values — separate them with commas.'
        : 'Written exactly as typed, without ExifTool’s display formatting.';

      // Seed from the raw value, never from describeTagValue — that is a
      // display string ("(binary, 2000 bytes encoded)") and writing it back
      // would put the description into the file.
      const seed = staged && staged.op === 'set' ? staged.value : value;
      tagDialogValue.value =
        seed === undefined || seed === null
          ? ''
          : Array.isArray(seed)
            ? seed.join(', ')
            : String(seed);

      tagDialog.showModal();
      tagDialogValue.focus();
      tagDialogValue.select();
    }

    tagDialogCancel.addEventListener('click', () => tagDialog.close());

    tagDialogConfirm.addEventListener('click', () => {
      if (!tagBeingEdited) return;
      const raw = tagDialogValue.value;
      const previous = currentTagValue(tagBeingEdited);
      tagDialog.close();

      if (raw.trim() === '') {
        // Emptying the box means "remove this tag", matching the curated
        // fields. But a tag that was already absent and is still empty stages
        // nothing at all — issuing a delete for something that was never there
        // would rewrite the file to achieve no change.
        const wasAbsent = previous === undefined || previous === null;
        stageTag(tagBeingEdited, wasAbsent ? null : { op: 'clear' });
        return;
      }

      const value = Array.isArray(previous) ? S.parseList(raw) : raw;
      stageTag(tagBeingEdited, { op: 'set', value });
    });

    /* ── The tag picker ──────────────────────────────────────────────────────
       Adding a tag the photo does not have. The list is fetched from the
       bundled ExifTool on first open rather than shipped, so it can never
       offer something this build cannot write — and never at launch, because
       it costs seconds most sessions do not need.                           */

    /** The catalogue, once fetched. Null until the first successful load. */
    let catalogue = null;
    let catalogueLoading = false;

    async function openTagPicker() {
      tagPickerFilter.value = '';
      tagPicker.showModal();

      if (!catalogue && !catalogueLoading) {
        catalogueLoading = true;
        renderTagOptions('Loading the tag list from ExifTool…');
        try {
          catalogue = await onLoadTags();
        } catch (error) {
          // Left null so the next open retries. A broken vendor tree should not
          // disable the picker for the rest of the session.
          renderTagOptions(`Could not load the tag list. ${error.message || error}`);
          return;
        } finally {
          catalogueLoading = false;
        }
      }
      renderTagOptions();
      tagPickerFilter.focus();
    }

    function renderTagOptions(message) {
      tagPickerList.innerHTML = '';
      if (message || !catalogue) {
        const hint = document.createElement('div');
        hint.className = 'panel-hint';
        hint.textContent = message || 'No tags available.';
        tagPickerList.appendChild(hint);
        return;
      }

      const needle = tagPickerFilter.value.trim().toLowerCase();
      const matching = catalogue.filter(
        (t) =>
          !needle ||
          t.tag.toLowerCase().includes(needle) ||
          (t.description || '').toLowerCase().includes(needle)
      );

      if (!matching.length) {
        const hint = document.createElement('div');
        hint.className = 'panel-hint';
        hint.textContent = 'No tags match that search.';
        tagPickerList.appendChild(hint);
        return;
      }

      // Capped rather than paginated. Two thousand buttons is a slow dialog and
      // a useless list; someone looking for a specific tag types a few letters,
      // and the count tells them whether to keep typing.
      const shown = matching.slice(0, 200);
      for (const info of shown) {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'tag-option';
        option.dataset.tag = info.tag;
        option.innerHTML =
          `<span class="name"></span><span class="kind"></span>` +
          `<span class="desc"></span>`;
        // textContent, not innerHTML: these strings come from ExifTool's own
        // database and are not ours to trust as markup.
        option.querySelector('.name').textContent = info.tag;
        option.querySelector('.kind').textContent = info.type || '';
        option.querySelector('.desc').textContent = info.description || '';
        tagPickerList.appendChild(option);
      }
      if (matching.length > shown.length) {
        const hint = document.createElement('div');
        hint.className = 'panel-hint';
        hint.textContent =
          `${matching.length} tags match — showing the first ${shown.length}. ` +
          `Keep typing to narrow it down.`;
        tagPickerList.appendChild(hint);
      }
    }

    tagPickerList.addEventListener('click', (event) => {
      const option = event.target.closest('button[data-tag]');
      if (!option) return;
      tagPicker.close();
      // Straight into the same value dialog an edit uses, seeded empty. A
      // chosen tag stages exactly like an edited one, so nothing new reaches
      // the write path.
      openTagDialog(option.dataset.tag, currentTagValue(option.dataset.tag));
    });

    tagPickerFilter.addEventListener('input', () => renderTagOptions());
    tagPickerCancel.addEventListener('click', () => tagPicker.close());
    addTagButton.addEventListener('click', openTagPicker);

    /* ── Public ──────────────────────────────────────────────────────────── */

    return {
      show(entries, entryDrafts) {
        current = entries || [];
        drafts = entryDrafts || [];
        editable = current.length > 0;
        // Seeded from the drafts rather than blanked. The old unconditional
        // reset here is what silently destroyed a half-typed edit the moment
        // the user clicked another photo.
        seedFromDrafts();
        const has = current.length > 0;
        editHint.hidden = has;
        editFields.hidden = !has;
        if (has) renderFields(current);
        renderInspector(current);
        // The All tab only renders for a single photo, so adding a tag only
        // means anything there.
        addTagButton.disabled = current.length !== 1;
        refreshFooter();
      },
      clear() {
        current = [];
        drafts = [];
        pending = {};
        gpsPending = undefined;
        tagPending = {};
        editable = false;
        editHint.hidden = false;
        editHint.textContent = 'Select a photo to see its metadata.';
        editFields.hidden = true;
        editFields.innerHTML = '';
        footer.hidden = true;
        addTagButton.disabled = true;
        renderInspector([]);
      },
      loading(count) {
        editHint.hidden = false;
        editHint.textContent =
          count === 1 ? 'Reading metadata…' : `Reading metadata for ${count} photos…`;
        editFields.hidden = true;
        footer.hidden = true;
      },
      hasPendingChanges() {
        return !S.editIsEmpty(currentEdit());
      },

      /**
       * What the user has typed in this view, as a draft.
       *
       * Raw values only — no baseline. See the drafts note in state.js for why
       * storing one would eventually write nothing and report success.
       */
      captureDraft() {
        return {
          pending: { ...pending },
          gpsPending,
          tagPending: { ...tagPending },
        };
      },

      /**
       * Redraws the pending bar from the app's current draft counts.
       *
       * For the places that change drafts from outside the panel — applying,
       * reverting, the selection emptying — where nothing here would otherwise
       * know to look again. Does not notify, or it would ask the app to
       * recapture a panel it is in the middle of updating.
       */
      refreshCounts() {
        refreshFooter(false);
      },
    };
  }

  window.ExifPanel = { createPanel };
})();
