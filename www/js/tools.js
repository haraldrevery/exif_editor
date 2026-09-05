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

  function createTools({ container, getSelection, onApplied, setStatus, confirm, describeWriteFailure }) {
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

    /**
     * Shifts every selected photo's timestamps.
     *
     * **This is the only operation in the app that is not idempotent.** Every
     * other write sends an absolute value — clear-then-set for a field, a
     * coordinate pair for GPS — so applying it twice lands the same result.
     * A shift sends `-AllDates+=H:M:S`, which ExifTool applies relative to
     * whatever each tag currently holds, so applying it twice moves the clock
     * twice and the second batch's undo snapshot replaces the first.
     *
     * That is survivable as long as the user knows whether the last attempt
     * landed. When they cannot know — the engine stopped answering mid-batch —
     * the control is reset so a retry has to be deliberately re-entered rather
     * than being one more click on a button still showing the old amount.
     */
    async function applyShift() {
      const { paths } = getSelection();
      if (!paths.length || shiftSeconds === 0) return;
      const confirmed = await run(
        paths,
        { dates: { op: 'shift', seconds: shiftSeconds } },
        'Shifting dates…'
      );
      if (!confirmed) {
        resetShift();
        return;
      }
      await refreshShift();
    }

    /** Returns the shift controls to zero, so nothing repeats by reflex. */
    function resetShift() {
      shiftSeconds = 0;
      shiftRows = null;
      el.hours.value = '0';
      el.minutes.value = '0';
      el.shiftPreview.hidden = true;
      el.shiftApply.hidden = true;
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

    /**
     * The source photo and the photos it would be copied to.
     *
     * `entries` is the selection's metadata with unreadable files *filtered
     * out*, so it is not index-aligned with `paths`. Reading the source from
     * `entries[0]` while taking the targets from `paths.slice(1)` therefore
     * silently disagreed with itself the moment the first selected photo had
     * no metadata — which happens whenever its read is still in flight, and
     * permanently for a file ExifTool cannot read, since `refreshPanel`
     * documents that such a file is *omitted* from the response rather than
     * returned as null. The source became the second photo, and the first was
     * excluded from the targets while keeping its own values.
     *
     * So the source is resolved by path and the targets are derived from it,
     * rather than the two being read off separate lists that are assumed to
     * line up.
     */
    function copyPlan() {
      const { paths, entries } = getSelection();
      if (paths.length < 2) return null;
      const sourcePath = paths[0];
      const source = S.entryForPath(entries, sourcePath);
      if (!source) return null;
      return { source, sourcePath, targets: paths.slice(1) };
    }

    function refreshCopy() {
      const { paths } = getSelection();
      const plan = copyPlan();
      el.copyApply.disabled = !plan;
      if (plan) {
        el.copyNote.textContent =
          `Takes the ticked fields from ${S.basename(plan.sourcePath)} ` +
          `and writes them to the other ${plan.targets.length}.`;
      } else if (paths.length > 1) {
        // Named rather than left as a dead button: the metadata read may still
        // be running, and "nothing happens when I click it" is not an answer.
        el.copyNote.textContent =
          `Still reading ${S.basename(paths[0])}. The first selected photo is ` +
          `the source, and its metadata has to be readable first.`;
      } else {
        el.copyNote.textContent = 'Select two or more photos. The first is the source.';
      }
    }

    async function applyCopy() {
      const plan = copyPlan();
      if (!plan) return;
      const { source, targets } = plan;

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
      // file to no effect. `targets` comes from the same plan the source did,
      // so the excluded photo is always the one being read from.
      await run(targets, edit, 'Copying…');
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

    /**
     * Runs one tool's write.
     *
     * Returns false when the outcome is *unknown* rather than merely failed —
     * the engine stopped answering, so the write may have gone ahead. Only
     * `applyShift` acts on that, because it is the only caller for which
     * repeating the action is not harmless.
     */
    async function run(paths, edit, message) {
      setStatus(message);
      try {
        const outcome = await window.NativeAPI.applyEdit(paths, edit);
        onApplied(outcome, paths.length);
        return true;
      } catch (error) {
        setStatus(describeWriteFailure(error), true);
        return !(error && error.unconfirmed);
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
