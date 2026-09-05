/**
 * Pending-changes model and coordinate parsing.
 *
 * `buildEdit` decides what actually reaches the file. Every bug here writes
 * something the user did not ask for, so the untouched/set/cleared distinction
 * is pinned exhaustively.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const S = require('../www/js/state.js');

/** The resolutions a field starts from, as the panel would supply them. */
const was = {
  set: (value) => ({ state: 'single', value }),
  empty: () => ({ state: 'empty' }),
  mixed: () => ({ state: 'mixed' }),
};

/* ── What reaches the file ───────────────────────────────────────────────── */

test('an untouched field produces no change', () => {
  // Nothing typed at all.
  assert.deepEqual(S.buildEdit({}, { title: was.set('Fjord') }), {});
});

test('retyping the same value produces no change', () => {
  // Otherwise clicking into a field and out again would rewrite the file.
  const edit = S.buildEdit({ title: 'Fjord' }, { title: was.set('Fjord') });
  assert.deepEqual(edit, {});
});

test('a new value becomes a set', () => {
  const edit = S.buildEdit({ title: 'Winter' }, { title: was.set('Fjord') });
  assert.deepEqual(edit, { title: { op: 'set', value: 'Winter' } });
});

test('emptying a field that had a value is a clear', () => {
  const edit = S.buildEdit({ copyright: '' }, { copyright: was.set('© 2020') });
  assert.deepEqual(edit, { copyright: { op: 'clear' } });
});

test('emptying a field that was already empty does nothing', () => {
  // A clear here would issue tag deletions for tags that were never present,
  // rewriting the file to achieve exactly nothing.
  const edit = S.buildEdit({ copyright: '' }, { copyright: was.empty() });
  assert.deepEqual(edit, {});
});

test('whitespace only counts as empty', () => {
  assert.deepEqual(S.buildEdit({ title: '   ' }, { title: was.set('Fjord') }), {
    title: { op: 'clear' },
  });
});

test('emptying a mixed field clears it across the selection', () => {
  // The files disagreed and the user deliberately blanked the box: that is an
  // instruction to remove the value everywhere, not to leave them alone.
  const edit = S.buildEdit({ title: '' }, { title: was.mixed() });
  assert.deepEqual(edit, { title: { op: 'clear' } });
});

test('typing into a mixed field sets it everywhere', () => {
  const edit = S.buildEdit({ title: 'Uniform' }, { title: was.mixed() });
  assert.deepEqual(edit, { title: { op: 'set', value: 'Uniform' } });
});

test('read-only fields are never written', () => {
  // Camera and lens are shown for context; the app must not offer to rewrite
  // what the camera recorded.
  const edit = S.buildEdit({ camera: 'Fake Camera' }, { camera: was.set('Canon EOS R6') });
  assert.deepEqual(edit, {});
});

test('list fields split on commas and drop blanks', () => {
  const edit = S.buildEdit({ keywords: 'sea, north ,, winter ' }, { keywords: was.empty() });
  assert.deepEqual(edit, { keywords: { op: 'set', value: ['sea', 'north', 'winter'] } });
});

test('reordering keywords is a real change', () => {
  const edit = S.buildEdit(
    { keywords: 'north, sea' },
    { keywords: was.set(['sea', 'north']) }
  );
  assert.deepEqual(edit, { keywords: { op: 'set', value: ['north', 'sea'] } });
});

test('the same keywords in the same order are not a change', () => {
  const edit = S.buildEdit(
    { keywords: 'sea, north' },
    { keywords: was.set(['sea', 'north']) }
  );
  assert.deepEqual(edit, {});
});

test('several fields combine into one edit', () => {
  const edit = S.buildEdit(
    { title: 'New', copyright: '', keywords: 'a' },
    { title: was.set('Old'), copyright: was.set('© 2020'), keywords: was.empty() }
  );
  assert.deepEqual(edit, {
    title: { op: 'set', value: 'New' },
    copyright: { op: 'clear' },
    keywords: { op: 'set', value: ['a'] },
  });
});

/* ── GPS ─────────────────────────────────────────────────────────────────── */

const oslo = { latitude: 59.9139, longitude: 10.7522 };

test('an unchanged position produces no gps edit', () => {
  assert.deepEqual(S.buildEdit({}, {}, undefined, oslo), {});
  assert.deepEqual(S.buildEdit({}, {}, { ...oslo }, oslo), {});
});

test('a moved pin becomes a gps set', () => {
  const moved = { latitude: 60.0, longitude: 10.7522 };
  assert.deepEqual(S.buildEdit({}, {}, moved, oslo), {
    gps: { op: 'set', position: moved },
  });
});

test('removing the location on a photo that had one is a clear', () => {
  assert.deepEqual(S.buildEdit({}, {}, null, oslo), { gps: { op: 'clear' } });
});

test('removing the location on a photo that had none does nothing', () => {
  assert.deepEqual(S.buildEdit({}, {}, null, null), {});
});

/* ── The review diff ─────────────────────────────────────────────────────── */

test('the diff names what changes, from and to', () => {
  const rows = S.summariseEdit(
    { title: { op: 'set', value: 'New' }, copyright: { op: 'clear' } },
    { title: was.set('Old'), copyright: was.set('© 2020') }
  );
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r]));
  assert.equal(byLabel.Title.from, 'Old');
  assert.equal(byLabel.Title.to, 'New');
  assert.equal(byLabel.Copyright.from, '© 2020');
  // "removed" rather than an empty cell, so a deletion cannot be mistaken for
  // a blank row in the review.
  assert.equal(byLabel.Copyright.to, 'removed');
});

test('an empty edit is recognised as a no-op', () => {
  assert.ok(S.editIsEmpty({}));
  assert.ok(S.editIsEmpty(null));
  assert.ok(!S.editIsEmpty({ title: { op: 'clear' } }));
});

/* ── Coordinate parsing ──────────────────────────────────────────────────── */

test('parses a plain signed decimal pair', () => {
  assert.deepEqual(S.parseCoordinates('59.9139, 10.7522'), oslo);
  assert.deepEqual(S.parseCoordinates('59.9139 10.7522'), oslo);
  assert.deepEqual(S.parseCoordinates('-33.4489,-70.6693'), {
    latitude: -33.4489,
    longitude: -70.6693,
  });
});

test('parses degrees, minutes and seconds with hemispheres', () => {
  const parsed = S.parseCoordinates('59°54\'50.0"N 10°45\'07.9"E');
  assert.ok(Math.abs(parsed.latitude - 59.9139) < 1e-4, `got ${parsed.latitude}`);
  assert.ok(Math.abs(parsed.longitude - 10.7522) < 1e-4, `got ${parsed.longitude}`);
});

test('applies southern and western hemispheres as negative', () => {
  const parsed = S.parseCoordinates('33°26\'56.0"S 70°40\'09.5"W');
  assert.ok(parsed.latitude < 0, `southern must be negative, got ${parsed.latitude}`);
  assert.ok(parsed.longitude < 0, `western must be negative, got ${parsed.longitude}`);
  assert.ok(Math.abs(parsed.latitude + 33.4489) < 1e-3, `got ${parsed.latitude}`);
});

test('orders by hemisphere letter, not by position in the string', () => {
  // Longitude written first. Reading positionally would swap the pair and put
  // the photo somewhere else entirely.
  const parsed = S.parseCoordinates('10°45\'07.9"E 59°54\'50.0"N');
  assert.ok(Math.abs(parsed.latitude - 59.9139) < 1e-4, `got ${parsed.latitude}`);
  assert.ok(Math.abs(parsed.longitude - 10.7522) < 1e-4, `got ${parsed.longitude}`);
});

test('parses a Google Maps URL', () => {
  const parsed = S.parseCoordinates(
    'https://www.google.com/maps/@59.9139,10.7522,15z'
  );
  assert.deepEqual(parsed, oslo);
});

test('rejects a signed value that also carries a hemisphere letter', () => {
  // "-33.4489 S" is ambiguous: the sign and the letter both say south, so one
  // reading is 33.4489°N. Guessing would silently misplace the photo, so this
  // is refused and the user retypes it.
  assert.equal(S.parseCoordinates('-33.4489 S, 70.6693 W'), null);
});

test('rejects out-of-range and unparseable input', () => {
  assert.equal(S.parseCoordinates('91, 0'), null);
  assert.equal(S.parseCoordinates('0, 181'), null);
  assert.equal(S.parseCoordinates('somewhere nice'), null);
  assert.equal(S.parseCoordinates(''), null);
  assert.equal(S.parseCoordinates(null), null);
});

test('parses the app\'s own formatted output back', () => {
  // Round-trip: what the panel displays must be re-readable, or copy-paste
  // between two photos in the app silently fails.
  const formatted = S.formatPosition({ latitude: -33.4489, longitude: -70.6693 });
  assert.equal(formatted, '33.448900° S, 70.669300° W');
  const parsed = S.parseCoordinates(formatted);
  assert.ok(parsed, `could not reparse its own output: ${formatted}`);
  assert.ok(Math.abs(parsed.latitude + 33.4489) < 1e-4, `got ${parsed.latitude}`);
  assert.ok(Math.abs(parsed.longitude + 70.6693) < 1e-4, `got ${parsed.longitude}`);
});

/* ── GPS across a selection ──────────────────────────────────────────────── */

const santiago = { latitude: -33.4489, longitude: -70.6693 };

test('positions resolve into the same three states as fields', () => {
  assert.deepEqual(S.resolvePositions([]), { state: 'empty' });
  // Nobody has a location.
  assert.deepEqual(S.resolvePositions([null, null]), { state: 'empty' });
  // Everybody is in the same place.
  assert.deepEqual(S.resolvePositions([oslo, { ...oslo }]), {
    state: 'single',
    value: oslo,
  });
  // They disagree.
  assert.deepEqual(S.resolvePositions([oslo, santiago]), { state: 'mixed' });
  // One located, one not, is a disagreement — not "empty".
  assert.deepEqual(S.resolvePositions([oslo, null]), { state: 'mixed' });
});

test('clearing the location on a mixed selection actually clears it', () => {
  // The bug this guards: if "they disagree" and "none has a location" both
  // collapsed to null, emptying the box here would do nothing at all — and the
  // photos that *did* carry coordinates would quietly keep them after the user
  // asked for them gone. For a privacy action, silence is the worst outcome.
  const mixed = S.resolvePositions([oslo, null]);
  assert.deepEqual(S.buildEdit({}, {}, null, mixed), { gps: { op: 'clear' } });
});

test('clearing the location when nobody has one still does nothing', () => {
  const empty = S.resolvePositions([null, null]);
  assert.deepEqual(S.buildEdit({}, {}, null, empty), {});
});

test('setting a location on a mixed selection is always a change', () => {
  const mixed = S.resolvePositions([oslo, santiago]);
  assert.deepEqual(S.buildEdit({}, {}, oslo, mixed), {
    gps: { op: 'set', position: oslo },
  });
});

test('retyping the agreed location of a selection is not a change', () => {
  const agreed = S.resolvePositions([oslo, { ...oslo }]);
  assert.deepEqual(S.buildEdit({}, {}, { ...oslo }, agreed), {});
});

test('a bare position is still accepted as a baseline', () => {
  // Callers that only ever deal with one file may pass the position directly.
  assert.deepEqual(S.buildEdit({}, {}, null, oslo), { gps: { op: 'clear' } });
  assert.deepEqual(S.buildEdit({}, {}, { ...oslo }, oslo), {});
});

test('the diff shows a mixed starting location as mixed', () => {
  const rows = S.summariseEdit(
    { gps: { op: 'clear' } },
    { gps: S.resolvePositions([oslo, santiago]) }
  );
  assert.equal(rows[0].label, 'Location');
  assert.equal(rows[0].from, '—— mixed ——');
  assert.equal(rows[0].to, 'removed');
});

/* ── Pasting from map sites ──────────────────────────────────────────────── */

test('accepts what the major map sites put on the clipboard', () => {
  // These are the real shapes: what "Copy coordinates" gives, and what sits in
  // the address bar. Someone pasting a link should not have to know which of
  // the four formats their site happens to use.
  const expect = (text, lat, lon) => {
    const p = S.parseCoordinates(text);
    assert.ok(p, `failed to parse: ${text}`);
    assert.ok(Math.abs(p.latitude - lat) < 1e-4, `${text} → lat ${p.latitude}`);
    assert.ok(Math.abs(p.longitude - lon) < 1e-4, `${text} → lon ${p.longitude}`);
  };

  // Google Maps: right-click → Copy coordinates.
  expect('59.913900, 10.752200', 59.9139, 10.7522);
  // Google Maps: address bar on a place.
  expect('https://www.google.com/maps/place/Oslo/@59.9139,10.7522,12z/data=!3m1', 59.9139, 10.7522);
  expect('https://www.google.com/maps?q=59.9139,10.7522', 59.9139, 10.7522);
  // OpenStreetMap: address bar. The zoom comes first, so the pair is the
  // second and third numbers — reading positionally would use the zoom.
  expect('https://www.openstreetmap.org/#map=15/59.9139/10.7522', 59.9139, 10.7522);
  // OpenStreetMap: share link. mlat/mlon is the dropped marker and must win
  // over the view centre in the fragment.
  expect(
    'https://www.openstreetmap.org/?mlat=59.9139&mlon=10.7522#map=12/60.0/11.0',
    59.9139,
    10.7522
  );
  expect('geo:59.9139,10.7522?z=15', 59.9139, 10.7522);
  expect('https://maps.apple.com/?ll=59.9139,10.7522', 59.9139, 10.7522);
  expect('https://www.bing.com/maps?cp=59.9139~10.7522', 59.9139, 10.7522);
});

test('a pasted link keeps southern and western signs', () => {
  const p = S.parseCoordinates('https://www.openstreetmap.org/#map=12/-33.4489/-70.6693');
  assert.ok(p.latitude < 0 && p.longitude < 0, `got ${JSON.stringify(p)}`);
});

test('a map link with no coordinates in it is refused', () => {
  // Google's short share links carry no coordinates at all — they resolve
  // server-side. Inventing a position would be far worse than saying no.
  assert.equal(S.parseCoordinates('https://maps.app.goo.gl/AbCdEf123'), null);
  assert.equal(S.parseCoordinates('https://www.openstreetmap.org/'), null);
});

/* ── Arbitrary tags from the All tab ─────────────────────────────────────── */

test('raw tags travel in their own map, not among the curated fields', () => {
  const edit = S.buildEdit({}, {}, undefined, null, {
    'EXIF:UserComment': { op: 'set', value: 'a note' },
    'XMP:Label': { op: 'clear' },
  });
  // A separate key space is what lets the backend tell "the title field" from
  // "the XMP:Title tag" and refuse an edit that names both.
  assert.deepEqual(edit.tags, {
    'EXIF:UserComment': { op: 'set', value: 'a note' },
    'XMP:Label': { op: 'clear' },
  });
  assert.equal(edit['EXIF:UserComment'], undefined);
});

test('a locked tag never reaches the backend', () => {
  const edit = S.buildEdit({}, {}, undefined, null, {
    'EXIF:Orientation': { op: 'clear' },
    'Composite:GPSLatitude': { op: 'clear' },
    'EXIF:UserComment': { op: 'set', value: 'kept' },
  });
  // The backend refuses these anyway. Dropping them here means a button that
  // should never have been drawn cannot fail the user's whole batch.
  assert.deepEqual(Object.keys(edit.tags), ['EXIF:UserComment']);
});

test('no tags staged means no tags key at all', () => {
  // An empty map would make editIsEmpty false and rewrite files for nothing.
  assert.equal(S.buildEdit({}, {}, undefined, null, {}).tags, undefined);
  assert.equal(S.buildEdit({}, {}, undefined, null, undefined).tags, undefined);
  assert.ok(S.editIsEmpty(S.buildEdit({}, {}, undefined, null, {})));
});

test('each staged tag counts as its own change', () => {
  const edit = S.buildEdit({ title: 'Fjord' }, {}, undefined, null, {
    'EXIF:UserComment': { op: 'set', value: 'a' },
    'XMP:Label': { op: 'clear' },
    'EXIF:Software': { op: 'clear' },
  });
  // Object.keys(edit).length would say 2 — one for title, one for the whole
  // tags map — and the bar that is the user's last look before writing would
  // understate what Apply is about to do.
  assert.equal(S.countChanges(edit), 4);
  assert.equal(S.countChanges({}), 0);
  assert.equal(S.countChanges(null), 0);
});

test('the review diff names a raw tag in full, with what it was', () => {
  const edit = S.buildEdit({}, {}, undefined, null, {
    'EXIF:UserComment': { op: 'set', value: 'after' },
    'EXIF:Software': { op: 'clear' },
  });
  const rows = S.summariseEdit(edit, {}, {
    'EXIF:UserComment': 'before',
    'EXIF:Software': 'Some Editor 1.0',
  });

  const comment = rows.find((r) => r.label === 'EXIF:UserComment');
  // The group is the half that says *which* tag is about to be overwritten,
  // so the label carries the full name rather than the bare one the row shows.
  assert.equal(comment.from, 'before');
  assert.equal(comment.to, 'after');

  const software = rows.find((r) => r.label === 'EXIF:Software');
  assert.equal(software.from, 'Some Editor 1.0');
  assert.equal(software.to, 'removed');
});

test('a raw tag that was not set reads as "not set" in the diff', () => {
  const edit = S.buildEdit({}, {}, undefined, null, {
    'EXIF:UserComment': { op: 'set', value: 'new' },
  });
  const rows = S.summariseEdit(edit, {}, {});
  assert.equal(rows[0].from, 'not set');
});
