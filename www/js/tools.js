/**
 * tools.js — the Tools tab: date shift, copy from a photo, and strip metadata.
 *
 * Each of these acts on the whole selection at once, and each can lose work if
 * it is wrong, so all three preview before they write and all three go through
 * the same verified, undoable batch path as an ordinary edit.
 */

(function () {
  'use strict';

  const S = window.ExifState;

  /** Field groups the copy tool can carry across. */
  const COPY_GROUPS = [
    { key: 'description', label: 'Title and description', fields: ['title', 'description'] },
    { key: 'keywords', label: 'Keywords', fields: ['keywords'] },
    { key: 'credit', label: 'Creator and copyright', fields: ['creator', 'copyright'] },
    { key: 'rating', label: 'Rating', fields: ['rating'] },
  ];

  function createTools({ container, getSelection, onApplied, setStatus, confirm }) {
    let shiftSeconds = 0;
    let shiftRows = null;
    const el = {};

    function build() {
      container.innerHTML = '';
      container.append(buildShift(), buildCopy(), buildStrip());
    }

    /* ── Date shift ──────────────────────────────────────────────────────── */

    function buildShift() {
      const section = document.createElement('section');
      section.className = 'geo-section';
      const heading = document.createElement('h3');
      heading.innerHTML =
        '<span class="icon icon-calendar" aria-hidden="true"></span>Shift dates';
      const blurb = document.createElement('p');
      blurb.className = 'field-hint';
      blurb.textContent =
        'For a camera whose clock was wrong. Every timestamp moves by the ' +
        'same amount, keeping the intervals between photos.';

      const row = document.createElement('div');
      row.className = 'shift-row';
      for (const unit of ['hours', 'minutes']) {
        const wrap = document.createElement('label');
        wrap.className = 'shift-field';
        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'value input';
        input.value = '0';
        input.step = '1';
        input.addEventListener('input', () => {
          shiftSeconds =
            Number(el.hours.value || 0) * 3600 + Number(el.minutes.value || 0) * 60;
          refreshShift();
        });
        el[unit] = input;
        const caption = document.createElement('span');
        caption.textContent = unit;
        wrap.append(input, caption);
        row.appendChild(wrap);
      }

      el.shiftPreview = document.createElement('div');
      el.shiftPreview.className = 'geo-summary';
      el.shiftPreview.hidden = true;

      el.shiftApply = document.createElement('button');
      el.shiftApply.className = 'primary';
      el.shiftApply.textContent = 'Shift dates';
      el.shiftApply.hidden = true;
      el.shiftApply.addEventListener('click', applyShift);

      section.append(heading, blurb, row, el.shiftPreview, el.shiftApply);
      return section;
    }

    async function refreshShift() {
      const { paths } = getSelection();
      if (!paths.length || shiftSeconds === 0) {
        el.shiftPreview.hidden = true;
        el.shiftApply.hidden = true;
        return;
      }
      try {
        shiftRows = await window.NativeAPI.previewDateShift(paths, shiftSeconds);
      } catch (error) {
        el.shiftPreview.hidden = false;
        el.shiftPreview.textContent = String(error.message || error);
        el.shiftApply.hidden = true;
        return;
      }
      const shiftable = shiftRows.filter((r) => r.after);
      const skipped = shiftRows.length - shiftable.length;

      el.shiftPreview.hidden = false;
      el.shiftPreview.classList.toggle('none', shiftable.length === 0);
      if (!shiftable.length) {
        el.shiftPreview.textContent =
          'None of the selected photos has a capture time to shift.';
        el.shiftApply.hidden = true;
        return;
      }
      // Show a concrete before → after. A signed number of hours is easy to
      // get backwards; an actual timestamp is not.
      const sample = shiftable[0];
      el.shiftPreview.textContent =
        `${S.basename(sample.path)}: ${sample.before} → ${sample.after}` +
        (shiftable.length > 1 ? `, and ${shiftable.length - 1} more` : '') +
        (skipped ? `. ${skipped} have no capture time and will be left alone.` : '');
      el.shiftApply.hidden = false;
      el.shiftApply.textContent =
        shiftable.length === 1 ? 'Shift 1 photo' : `Shift ${shiftable.length} photos`;
    }

    async function applyShift() {
      const { paths } = getSelection();
      if (!paths.length || shiftSeconds === 0) return;
      await run(paths, { dates: { op: 'shift', seconds: shiftSeconds } }, 'Shifting dates…');
      await refreshShift();
    }

    /* ── Copy from a photo ───────────────────────────────────────────────── */

    function buildCopy() {
      const section = document.createElement('section');
      section.className = 'geo-section';
      const heading = document.createElement('h3');
      heading.innerHTML =
        '<span class="icon icon-export" aria-hidden="true"></span>' +
        'Copy from the first selected photo';
      el.copyNote = document.createElement('p');
      el.copyNote.className = 'field-hint';

      el.copyGroups = document.createElement('div');
      for (const group of COPY_GROUPS) {
        const label = document.createElement('label');
        label.className = 'checkbox-row';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.dataset.group = group.key;
        const text = document.createElement('span');
        text.textContent = group.label;
        label.append(box, text);
        el.copyGroups.appendChild(label);
      }

      el.copyApply = document.createElement('button');
      el.copyApply.className = 'primary';
      el.copyApply.textContent = 'Copy to the rest';
      el.copyApply.addEventListener('click', applyCopy);

      section.append(heading, el.copyNote, el.copyGroups, el.copyApply);
      return section;
    }

    function refreshCopy() {
      const { paths, entries } = getSelection();
      const ready = paths.length > 1 && entries.length > 0;
      el.copyApply.disabled = !ready;
      el.copyNote.textContent = ready
        ? `Takes the ticked fields from ${S.basename(entries[0].SourceFile)} ` +
          `and writes them to the other ${paths.length - 1}.`
        : 'Select two or more photos. The first is the source.';
    }

    async function applyCopy() {
      const { paths, entries } = getSelection();
      if (paths.length < 2 || !entries.length) return;
      const source = entries[0];

      const chosen = [...el.copyGroups.querySelectorAll('input:checked')].map(
        (box) => box.dataset.group
      );
      if (!chosen.length) {
        setStatus('Tick at least one thing to copy.', true);
        return;
      }

      const edit = {};
      for (const group of COPY_GROUPS) {
        if (!chosen.includes(group.key)) continue;
        for (const key of group.fields) {
          const field = S.FIELDS.find((f) => f.key === key);
          const value = S.readField(source, field);
          // A field the source does not have is cleared on the targets, so
          // "copy" means "make these match" rather than leaving a stale value
          // behind on some of them.
          edit[key] = value === null ? { op: 'clear' } : { op: 'set', value };
        }
      }
      // The source already has these values; writing to it would rewrite the
      // file to no effect.
      await run(paths.slice(1), edit, 'Copying…');
    }

    /* ── Strip ───────────────────────────────────────────────────────────── */

    function buildStrip() {
      const section = document.createElement('section');
      section.className = 'geo-section';
      const heading = document.createElement('h3');
      heading.innerHTML =
        '<span class="icon icon-delete" aria-hidden="true"></span>Remove metadata';
      const blurb = document.createElement('p');
      blurb.className = 'field-hint';
      blurb.textContent =
        'For publishing. Orientation and the colour profile are always kept, ' +
        'so the photo still displays correctly.';

      el.stripLocation = document.createElement('button');
      el.stripLocation.textContent = 'Remove location only';
      el.stripLocation.addEventListener('click', () => applyStrip('location'));

      el.stripAll = document.createElement('button');
      el.stripAll.className = 'danger';
      el.stripAll.textContent = 'Remove all metadata';
      el.stripAll.addEventListener('click', () => applyStrip('everything'));

      const row = document.createElement('div');
      row.className = 'strip-row';
      row.append(el.stripLocation, el.stripAll);
      section.append(heading, blurb, row);
      return section;
    }

    async function applyStrip(what) {
      const { paths } = getSelection();
      if (!paths.length) return;
      const noun = paths.length === 1 ? 'this photo' : `${paths.length} photos`;
      const question =
        what === 'location'
          ? `Remove the location from ${noun}?`
          : `Remove all metadata from ${noun}? This deletes the date, camera, ` +
            `caption, keywords and location.`;
      // Destructive and wholesale, so it asks first — the pending-changes
      // review that guards ordinary edits does not apply to a one-click action.
      if (!(await confirm(question, 'Remove'))) return;
      await run(paths, { strip: what }, 'Removing metadata…');
    }

    /* ── Shared ──────────────────────────────────────────────────────────── */

    async function run(paths, edit, message) {
      setStatus(message);
      try {
        const outcome = await window.NativeAPI.applyEdit(paths, edit);
        onApplied(outcome, paths.length);
      } catch (error) {
        setStatus(`Nothing was changed. ${error.message || error}`, true);
      }
    }

    build();

    return {
      refresh() {
        refreshCopy();
        refreshShift();
        const { paths } = getSelection();
        el.stripLocation.disabled = paths.length === 0;
        el.stripAll.disabled = paths.length === 0;
      },
    };
  }

  window.ExifTools = { createTools, COPY_GROUPS };
})();
