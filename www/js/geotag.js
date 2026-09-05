/**
 * geotag.js — the Map tab: copy a location across a selection, and geotag from
 * a GPX track.
 *
 * The design point is the preview. Geotagging is the one operation where the
 * user cannot tell by looking whether it worked: a wrong timezone produces a
 * confident, plausible, entirely incorrect result. So the match count updates
 * live as the offset changes, the photos that will *not* be tagged are listed
 * with the reason, and nothing is written until Apply.
 */

(function () {
  'use strict';

  const S = window.ExifState;

  /** Zone offsets people actually use, as {label, seconds}. */
  function offsetOptions() {
    const specials = [-3.5, 3.5, 4.5, 5.5, 5.75, 6.5, 8.75, 9.5, 10.5, 12.75, 13.75];
    const hours = [];
    for (let h = -12; h <= 14; h += 1) hours.push(h);
    return hours
      .concat(specials)
      .sort((a, b) => a - b)
      .map((h) => {
        const sign = h < 0 ? '-' : '+';
        const abs = Math.abs(h);
        const hh = String(Math.floor(abs)).padStart(2, '0');
        const mm = String(Math.round((abs % 1) * 60)).padStart(2, '0');
        return { label: `UTC${sign}${hh}:${mm}`, seconds: Math.round(h * 3600) };
      });
  }

  /** Human wording for why a photo did not match. */
  const REASONS = {
    noCaptureTime: 'no capture time recorded',
    beforeTrack: 'taken before the track starts',
    afterTrack: 'taken after the track ends',
    insideGap: 'taken during a gap in the track',
  };

  function formatUtc(seconds) {
    // Fixed UTC rendering — the browser's local zone is irrelevant here and
    // would make the displayed track times disagree with the offset control.
    return new Date(seconds * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  }

  function createGeotag({ container, getSelection, onApplied, setStatus }) {
    let trackPath = null;
    let preview = null;
    let offsetSeconds = 0;
    let busy = false;

    const el = {};

    function build() {
      container.innerHTML = '';

      /* ── Copy a location across the selection ────────────────────────── */
      const copySection = document.createElement('section');
      copySection.className = 'geo-section';
      const copyHeading = document.createElement('h3');
      copyHeading.innerHTML =
        '<span class="icon icon-pin" aria-hidden="true"></span>Copy location';
      el.copyNote = document.createElement('p');
      el.copyNote.className = 'field-hint';
      el.copyButton = document.createElement('button');
      el.copyButton.textContent = 'Apply to all selected';
      el.copyButton.addEventListener('click', copyToSelection);
      copySection.append(copyHeading, el.copyNote, el.copyButton);

      /* ── Geotag from a track ─────────────────────────────────────────── */
      const gpxSection = document.createElement('section');
      gpxSection.className = 'geo-section';
      const gpxHeading = document.createElement('h3');
      gpxHeading.innerHTML =
        '<span class="icon icon-compass-navigation" aria-hidden="true"></span>' +
        'Geotag from a GPS track';

      el.chooseTrack = document.createElement('button');
      el.chooseTrack.textContent = 'Choose .gpx file…';
      el.chooseTrack.addEventListener('click', chooseTrack);

      el.trackNote = document.createElement('p');
      el.trackNote.className = 'field-hint';
      el.trackNote.textContent = 'No track loaded.';

      const offsetRow = document.createElement('div');
      offsetRow.className = 'field';
      const offsetLabel = document.createElement('label');
      offsetLabel.textContent = 'Camera time zone';
      offsetLabel.htmlFor = 'geo-offset';
      el.offset = document.createElement('select');
      el.offset.id = 'geo-offset';
      el.offset.className = 'value input';
      for (const option of offsetOptions()) {
        const node = document.createElement('option');
        node.value = String(option.seconds);
        node.textContent = option.label;
        if (option.seconds === 0) node.selected = true;
        el.offset.appendChild(node);
      }
      el.offset.addEventListener('change', () => {
        offsetSeconds = Number(el.offset.value);
        refreshPreview();
      });
      const offsetHint = document.createElement('div');
      offsetHint.className = 'field-hint';
      offsetHint.textContent =
        'Used only for photos whose camera did not record its own offset.';
      offsetRow.append(offsetLabel, el.offset, offsetHint);

      el.summary = document.createElement('div');
      el.summary.className = 'geo-summary';
      el.summary.hidden = true;

      el.unmatched = document.createElement('div');
      el.unmatched.className = 'geo-unmatched';
      el.unmatched.hidden = true;

      el.apply = document.createElement('button');
      el.apply.className = 'primary';
      el.apply.textContent = 'Write locations';
      el.apply.hidden = true;
      el.apply.addEventListener('click', apply);

      gpxSection.append(
        gpxHeading,
        el.chooseTrack,
        el.trackNote,
        offsetRow,
        el.summary,
        el.unmatched,
        el.apply
      );

      container.append(copySection, gpxSection);
    }

    /* ── Copy location ─────────────────────────────────────────────────── */

    async function copyToSelection() {
      const { paths, entries } = getSelection();
      const source = entries.find((e) => S.positionOf(e));
      if (!source) return;
      const position = S.positionOf(source);
      const edit = { gps: { op: 'set', position } };
      try {
        setStatus(`Writing the location to ${paths.length} photos…`);
        const outcome = await window.NativeAPI.applyEdit(paths, edit);
        onApplied(outcome, paths.length);
      } catch (error) {
        setStatus(`Nothing was changed. ${error.message || error}`, true);
      }
    }

    function refreshCopy() {
      const { paths, entries } = getSelection();
      const located = entries.filter((e) => S.positionOf(e));
      const enabled = located.length > 0 && paths.length > 1;
      el.copyButton.disabled = !enabled;
      if (!paths.length) {
        el.copyNote.textContent = 'Select photos to copy a location between them.';
      } else if (!located.length) {
        el.copyNote.textContent = 'None of the selected photos has a location.';
      } else if (paths.length === 1) {
        el.copyNote.textContent =
          `This photo is at ${S.formatPosition(S.positionOf(located[0]))}. ` +
          `Select more photos to copy it to them.`;
      } else {
        const name = S.basename(located[0].SourceFile);
        el.copyNote.textContent =
          `Takes the location from ${name} (${S.formatPosition(S.positionOf(located[0]))}) ` +
          `and writes it to all ${paths.length} selected photos.`;
      }
    }

    /* ── Geotag ────────────────────────────────────────────────────────── */

    async function chooseTrack() {
      try {
        const picked = await window.NativeAPI.chooseGpxFile();
        if (!picked) return;
        trackPath = picked;
        await refreshPreview();
      } catch (error) {
        setStatus(`Could not open the track: ${error.message || error}`, true);
      }
    }

    async function refreshPreview() {
      const { paths } = getSelection();
      if (!trackPath || !paths.length || busy) {
        if (!trackPath) el.trackNote.textContent = 'No track loaded.';
        renderPreview(null);
        return;
      }
      busy = true;
      try {
        preview = await window.NativeAPI.previewGeotag(paths, trackPath, offsetSeconds);
        el.trackNote.textContent =
          `${S.basename(trackPath)} — ${preview.trackPoints} points, ` +
          `${formatUtc(preview.trackStart)} to ${formatUtc(preview.trackEnd)}`;
        renderPreview(preview);
      } catch (error) {
        preview = null;
        el.trackNote.textContent = String(error.message || error);
        renderPreview(null);
      } finally {
        busy = false;
      }
    }

    function renderPreview(preview) {
      if (!preview) {
        el.summary.hidden = true;
        el.unmatched.hidden = true;
        el.apply.hidden = true;
        return;
      }
      const total = preview.matches.length;
      const matched = preview.matched;

      el.summary.hidden = false;
      el.summary.classList.toggle('none', matched === 0);
      let text = `${matched} of ${total} photos match this track.`;
      if (preview.wouldReplace) {
        // Overwriting an existing fix is a different act from filling a blank.
        text += ` ${preview.wouldReplace} already ${
          preview.wouldReplace === 1 ? 'has a location that' : 'have locations that'
        } will be replaced.`;
      }
      if (matched === 0) {
        text += ' Check the camera time zone above.';
      }
      el.summary.textContent = text;

      const unmatched = preview.matches.filter((m) => !m.position);
      el.unmatched.hidden = unmatched.length === 0;
      el.unmatched.innerHTML = '';
      if (unmatched.length) {
        const heading = document.createElement('div');
        heading.className = 'field-hint';
        heading.textContent = 'Will not be tagged:';
        el.unmatched.appendChild(heading);
        // Named individually with the reason — "8 did not match" leaves the
        // user with no idea whether to change the zone, extend the track, or
        // fix a camera clock.
        for (const item of unmatched.slice(0, 12)) {
          const row = document.createElement('div');
          row.className = 'geo-skip';
          const name = document.createElement('span');
          name.textContent = S.basename(item.path);
          const why = document.createElement('span');
          why.className = 'geo-why';
          why.textContent = REASONS[item.reason] || 'no match';
          row.append(name, why);
          el.unmatched.appendChild(row);
        }
        if (unmatched.length > 12) {
          const more = document.createElement('div');
          more.className = 'field-hint';
          more.textContent = `…and ${unmatched.length - 12} more.`;
          el.unmatched.appendChild(more);
        }
      }

      el.apply.hidden = matched === 0;
      el.apply.textContent =
        matched === 1 ? 'Write 1 location' : `Write ${matched} locations`;
    }

    async function apply() {
      if (!preview) return;
      const assignments = preview.matches
        .filter((m) => m.position)
        .map((m) => ({ path: m.path, position: m.position }));
      if (!assignments.length) return;
      try {
        setStatus(`Writing ${assignments.length} locations…`);
        // The reviewed matches are sent, not re-derived, so what was approved
        // is exactly what lands.
        const outcome = await window.NativeAPI.applyGeotag(assignments);
        onApplied(outcome, assignments.length);
        await refreshPreview();
      } catch (error) {
        setStatus(`Nothing was changed. ${error.message || error}`, true);
      }
    }

    build();

    return {
      /** Called whenever the selection changes. */
      refresh() {
        refreshCopy();
        refreshPreview();
      },
    };
  }

  window.ExifGeotag = { createGeotag, offsetOptions, formatUtc };
})();
