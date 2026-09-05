/**
 * Selection model and multi-file field resolution.
 *
 * The empty/mixed distinction and the range-selection order are what a batch
 * editor gets wrong, and getting them wrong writes the wrong value to files
 * the user never looked at — so they are pinned here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const S = require('../www/js/state.js');

const field = (key) => S.FIELDS.find((f) => f.key === key);

/* ── Field resolution ────────────────────────────────────────────────────── */

test('reads a field from the first tag that carries a value', () => {
  // Title lives in XMP first, IPTC second.
  assert.equal(S.readField({ 'XMP:Title': 'Fjord' }, field('title')), 'Fjord');
  assert.equal(S.readField({ 'IPTC:ObjectName': 'Fjord' }, field('title')), 'Fjord');
  // XMP wins when both are present.
  assert.equal(
    S.readField({ 'XMP:Title': 'Fjord', 'IPTC:ObjectName': 'Old' }, field('title')),
    'Fjord'
  );
});

test('treats an empty string as absent, not as a value', () => {
  // ExifTool emits "" for a tag that exists but holds nothing. Reporting that
  // as a value would make a blank field look deliberately set.
  assert.equal(S.readField({ 'XMP:Title': '' }, field('title')), null);
  assert.equal(
    S.readField({ 'XMP:Title': '', 'IPTC:ObjectName': 'Real' }, field('title')),
    'Real'
  );
});

test('normalises a single keyword to an array', () => {
  // ExifTool emits a bare string for one keyword and an array for several.
  assert.deepEqual(S.readField({ 'XMP:Subject': 'sea' }, field('keywords')), ['sea']);
  assert.deepEqual(
    S.readField({ 'XMP:Subject': ['sea', '1998'] }, field('keywords')),
    ['sea', '1998']
  );
});

test('distinguishes empty from mixed across a selection', () => {
  const f = field('description');
  // Nothing set anywhere: the field is empty, and typing into it is safe.
  assert.deepEqual(S.resolveField([{}, {}], f), { state: 'empty' });

  // Everyone agrees.
  assert.deepEqual(
    S.resolveField([{ 'XMP:Description': 'Fjord' }, { 'XMP:Description': 'Fjord' }], f),
    { state: 'single', value: 'Fjord' }
  );

  // They disagree. This must NOT come back as one file's value, or a batch
  // write would silently stamp it over the others.
  assert.deepEqual(
    S.resolveField([{ 'XMP:Description': 'Fjord' }, { 'XMP:Description': 'Other' }], f),
    { state: 'mixed' }
  );

  // One set, one not, is also a disagreement — not "empty".
  assert.deepEqual(S.resolveField([{ 'XMP:Description': 'Fjord' }, {}], f), {
    state: 'mixed',
  });
});

test('creator is a list, because a photo can credit several people', () => {
  const f = field('creator');
  // dc:creator is an RDF Seq. ExifTool returns a bare string for one name and
  // an array for several; both normalise to an array so callers never branch.
  assert.deepEqual(S.readField({ 'XMP:Creator': 'Harald' }, f), ['Harald']);
  assert.deepEqual(S.readField({ 'XMP:Creator': ['Harald', 'Ada'] }, f), [
    'Harald',
    'Ada',
  ]);
  // A file storing one name in XMP and the same name in EXIF:Artist must not
  // read as a disagreement just because the shapes differ.
  assert.deepEqual(
    S.resolveField([{ 'XMP:Creator': ['Harald'] }, { 'EXIF:Artist': 'Harald' }], f),
    { state: 'single', value: ['Harald'] }
  );
});

test('compares keyword lists by content, not identity', () => {
  const f = field('keywords');
  assert.deepEqual(
    S.resolveField(
      [{ 'XMP:Subject': ['sea', 'north'] }, { 'IPTC:Keywords': ['sea', 'north'] }],
      f
    ),
    { state: 'single', value: ['sea', 'north'] }
  );
  // Order matters: the same words in a different order is a real difference.
  assert.deepEqual(
    S.resolveField(
      [{ 'XMP:Subject': ['sea', 'north'] }, { 'XMP:Subject': ['north', 'sea'] }],
      f
    ),
    { state: 'mixed' }
  );
});

test('a single file resolves to its own value', () => {
  assert.deepEqual(S.resolveField([{ 'XMP:Rating': 4 }], field('rating')), {
    state: 'single',
    value: 4,
  });
});

/* ── Selection ───────────────────────────────────────────────────────────── */

const ordered = ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg'];

test('plain click replaces the selection and sets the anchor', () => {
  const s = S.selectOnly(S.createSelection(), 'c.jpg');
  assert.deepEqual(s.paths, ['c.jpg']);
  assert.equal(s.anchor, 'c.jpg');
});

test('ctrl-click adds and removes', () => {
  let s = S.selectOnly(S.createSelection(), 'a.jpg');
  s = S.toggle(s, 'c.jpg');
  assert.deepEqual(s.paths, ['a.jpg', 'c.jpg']);
  s = S.toggle(s, 'a.jpg');
  assert.deepEqual(s.paths, ['c.jpg']);
  // The anchor must not be left pointing at something no longer selected.
  assert.equal(s.anchor, 'c.jpg');
});

test('shift-click covers display order, in both directions', () => {
  let s = S.selectOnly(S.createSelection(), 'b.jpg');
  s = S.selectRange(s, 'd.jpg', ordered);
  assert.deepEqual(s.paths, ['b.jpg', 'c.jpg', 'd.jpg']);

  // Dragging back the other way from the same anchor shrinks the range rather
  // than leapfrogging past it.
  s = S.selectRange(s, 'a.jpg', ordered);
  assert.deepEqual(s.paths, ['a.jpg', 'b.jpg']);
  assert.equal(s.anchor, 'b.jpg', 'the anchor must stay put across shift-clicks');
});

test('shift-click with no anchor behaves as a plain click', () => {
  const s = S.selectRange(S.createSelection(), 'c.jpg', ordered);
  assert.deepEqual(s.paths, ['c.jpg']);
});

test('range selection follows the filtered order, not the full folder', () => {
  // What the user sees is what shift-click must cover.
  const filtered = ['a.jpg', 'd.jpg', 'e.jpg'];
  let s = S.selectOnly(S.createSelection(), 'a.jpg');
  s = S.selectRange(s, 'e.jpg', filtered);
  assert.deepEqual(s.paths, filtered, 'must not pull in b.jpg and c.jpg');
});

test('pruning drops files that are gone after a refresh', () => {
  let s = S.selectAll(ordered);
  // c.jpg and e.jpg were deleted or renamed outside the app. Keeping them
  // selected would aim a later batch edit at files that do not exist.
  const remaining = ['a.jpg', 'b.jpg', 'd.jpg'];
  s = S.pruneSelection(s, remaining);
  assert.deepEqual(s.paths, remaining);
  assert.ok(remaining.includes(s.anchor));
});

test('pruning away the anchor moves it to something still present', () => {
  let s = S.selectOnly(S.createSelection(), 'c.jpg');
  s = S.toggle(s, 'd.jpg');
  s = S.pruneSelection(s, ['d.jpg']);
  assert.deepEqual(s.paths, ['d.jpg']);
  assert.equal(s.anchor, 'd.jpg');
});

/* ── Filtering ───────────────────────────────────────────────────────────── */

test('filters by name, case-insensitively', () => {
  const entries = [{ name: 'DSC_0001.JPG' }, { name: 'sunset.jpg' }, { name: 'IMG_9.heic' }];
  assert.equal(S.filterEntries(entries, 'dsc').length, 1);
  assert.equal(S.filterEntries(entries, 'JPG').length, 2);
  assert.equal(S.filterEntries(entries, '').length, 3);
  assert.equal(S.filterEntries(entries, '   ').length, 3);
});

/* ── GPS ─────────────────────────────────────────────────────────────────── */

test('reads the signed position, not the unsigned magnitude', () => {
  // Sydney, as ExifTool -n -G actually reports it: EXIF holds magnitudes with
  // a separate hemisphere ref, Composite holds the signed value.
  const entry = {
    'EXIF:GPSLatitude': 33.8688,
    'EXIF:GPSLatitudeRef': 'S',
    'EXIF:GPSLongitude': 151.2093,
    'EXIF:GPSLongitudeRef': 'W',
    'Composite:GPSLatitude': -33.8688,
    'Composite:GPSLongitude': -151.2093,
  };
  const p = S.positionOf(entry);
  assert.equal(p.latitude, -33.8688);
  assert.equal(p.longitude, -151.2093);
});

test('a photo with no GPS is null, never (0, 0)', () => {
  // (0, 0) is a real place in the Gulf of Guinea; defaulting there would drop
  // every un-geotagged photo onto the map at Null Island.
  assert.equal(S.positionOf({ 'EXIF:Make': 'Canon' }), null);
  assert.equal(S.positionOf({}), null);
  assert.equal(S.positionOf(null), null);
});

test('rejects out-of-range and non-numeric coordinates', () => {
  assert.equal(S.positionOf({ 'Composite:GPSLatitude': 91, 'Composite:GPSLongitude': 0 }), null);
  assert.equal(S.positionOf({ 'Composite:GPSLatitude': 0, 'Composite:GPSLongitude': 181 }), null);
  // ExifTool without -n returns strings like "59 deg 54' 50.04\"".
  assert.equal(
    S.positionOf({ 'Composite:GPSLatitude': "59 deg 54' 50.04\"", 'Composite:GPSLongitude': 10 }),
    null
  );
});

test('formats a position with explicit hemispheres', () => {
  assert.equal(
    S.formatPosition({ latitude: 59.9139, longitude: 10.7522 }),
    '59.913900° N, 10.752200° E'
  );
  // The sign is rendered as S/W and the number shown unsigned, so the value
  // is never ambiguous about which convention it is using.
  assert.equal(
    S.formatPosition({ latitude: -33.8688, longitude: -151.2093 }),
    '33.868800° S, 151.209300° W'
  );
  assert.equal(S.formatPosition(null), null);
});

/* ── Inspector grouping ──────────────────────────────────────────────────── */

test('groups tags by ExifTool group prefix, alphabetically', () => {
  const grouped = S.groupTags({
    SourceFile: '/photos/a.jpg',
    'XMP:Title': 'Fjord',
    'EXIF:Make': 'Canon',
    'EXIF:Model': 'R6',
    Orphan: 'no group',
  });
  const names = grouped.map((g) => g.group);
  assert.deepEqual(names, ['EXIF', 'Other', 'XMP']);
  // SourceFile is the file path, not metadata — it must not show as a tag.
  assert.ok(!grouped.some((g) => g.tags.some((t) => t.name === 'SourceFile')));
  assert.deepEqual(
    grouped.find((g) => g.group === 'EXIF').tags.map((t) => t.name),
    ['Make', 'Model']
  );
});

/* ── Display decisions ───────────────────────────────────────────────────── */

test('empty and mixed never render alike', () => {
  const f = field('description');
  const empty = S.describeField({ state: 'empty' }, f);
  const mixed = S.describeField({ state: 'mixed' }, f);
  // If these ever collapsed to the same text, "leave unchanged" and
  // "overwrite several different values" would look identical in the UI.
  assert.notEqual(empty.text, mixed.text);
  assert.notEqual(empty.modifier, mixed.modifier);
  assert.equal(empty.text, 'not set');
  assert.equal(mixed.text, '—— mixed ——');
});

test('a list field renders joined, not as [object Object]', () => {
  const described = S.describeField(
    { state: 'single', value: ['sea', 'north'] },
    field('keywords')
  );
  assert.equal(described.text, 'sea, north');
  assert.equal(described.modifier, null);
});

test('a numeric field renders as its number', () => {
  assert.equal(S.describeField({ state: 'single', value: 4 }, field('rating')).text, '4');
  // Zero must render, not vanish into a falsy check.
  assert.equal(S.describeField({ state: 'single', value: 0 }, field('rating')).text, '0');
});

test('position rows distinguish no-location from disagreement', () => {
  const oslo = { latitude: 59.9139, longitude: 10.7522 };
  const santiago = { latitude: -33.4489, longitude: -70.6693 };

  assert.equal(S.describePositions([]).text, 'no location');
  assert.equal(S.describePositions([null, null]).text, 'no location');
  assert.equal(S.describePositions([oslo, oslo]).modifier, null);
  assert.equal(S.describePositions([oslo, santiago]).modifier, 'mixed');
  // One photo located and one not is a disagreement, not "no location" —
  // otherwise a batch write could silently clear the one that had a fix.
  assert.equal(S.describePositions([oslo, null]).modifier, 'mixed');
});

test('binary tag values are summarised, not dumped', () => {
  const big = 'base64:' + 'A'.repeat(2_000_000);
  const described = S.describeTagValue(big);
  // A two-megabyte string in a DOM node locks the panel up.
  assert.ok(described.length < 60, `not summarised: ${described.length} chars`);
  assert.match(described, /binary, 2000000 bytes encoded/);
  // Ordinary values pass through untouched.
  assert.equal(S.describeTagValue('Canon EOS R6'), 'Canon EOS R6');
  assert.equal(S.describeTagValue(42), '42');
});

/* ── Paths ───────────────────────────────────────────────────────────────── */

test('basename handles both separators, because both reach the frontend', () => {
  // ExifTool's SourceFile: always forward slashes, even on Windows.
  assert.equal(S.basename('/home/h/photos/DSC_0001.jpg'), 'DSC_0001.jpg');
  assert.equal(S.basename('C:/Users/h/Pictures/DSC_0001.jpg'), 'DSC_0001.jpg');
  // PhotoEntry.path: the native separator, so backslashes on Windows. Split on
  // '/' alone this returns the entire path, which is what a Windows user saw
  // instead of a filename in every failure message.
  assert.equal(S.basename('C:\\Users\\h\\Pictures\\DSC_0001.jpg'), 'DSC_0001.jpg');
  // A verbatim path should one day never reach here, but must not break it.
  assert.equal(S.basename('\\\\?\\C:\\Users\\h\\a.jpg'), 'a.jpg');
  // Mixed separators, which is legal on Windows.
  assert.equal(S.basename('C:\\Users\\h/Pictures\\a.jpg'), 'a.jpg');

  assert.equal(S.basename('bare.jpg'), 'bare.jpg');
  assert.equal(S.basename(''), '');
  assert.equal(S.basename(null), '');
  assert.equal(S.basename(undefined), '');
  // A trailing separator yields the last real segment, not an empty string.
  assert.equal(S.basename('/home/h/photos/'), 'photos');
});

test('normalisePath makes the two path dialects comparable', () => {
  // The same file as Rust names it and as ExifTool names it.
  assert.equal(
    S.normalisePath('C:\\Users\\h\\Pictures\\a.jpg'),
    S.normalisePath('C:/Users/h/Pictures/a.jpg')
  );
  assert.equal(S.normalisePath('/home/h/photos/a.jpg'), '/home/h/photos/a.jpg');
  assert.equal(S.normalisePath(null), '');
  assert.equal(S.normalisePath(undefined), '');
  // Case is left alone: two files differing only by case are different files
  // on Linux, and folding here would let them collide.
  assert.notEqual(S.normalisePath('/photos/A.jpg'), S.normalisePath('/photos/a.jpg'));
});

test('each grouped tag carries the key it actually came from', () => {
  const grouped = S.groupTags({
    'EXIF:Make': 'Canon',
    Orphan: 'no group',
  });
  const exif = grouped.find((g) => g.group === 'EXIF').tags[0];
  assert.equal(exif.key, 'EXIF:Make');
  assert.equal(exif.name, 'Make');

  // The reason `key` exists rather than the caller reassembling
  // `${group}:${name}`: an ungrouped key would come back out as the tag
  // `Other:Orphan`, which is not a tag at all — and it is well-formed enough
  // that the write path would accept it and hand it to ExifTool.
  const other = grouped.find((g) => g.group === 'Other').tags[0];
  assert.equal(other.key, 'Orphan');
  assert.equal(other.name, 'Orphan');
  assert.notEqual(other.key, `${'Other'}:${other.name}`);
});

test('an ungrouped key is not editable, since it names no real tag', () => {
  // buildTagRow keys the row on `tag.key`, so this is what the All tab would
  // ask the backend to write.
  assert.ok(S.lockedReason('Orphan'), 'a key with no group must be locked');
});

/* ── Drafts ──────────────────────────────────────────────────────────────── */

test('a draft that touches nothing is empty, whatever shape it arrives in', () => {
  assert.ok(S.draftIsEmpty(null));
  assert.ok(S.draftIsEmpty(undefined));
  assert.ok(S.draftIsEmpty(S.EMPTY_DRAFT));
  assert.ok(S.draftIsEmpty({ pending: {}, tagPending: {} }));

  assert.ok(!S.draftIsEmpty({ pending: { title: 'Fjord' }, tagPending: {} }));
  assert.ok(!S.draftIsEmpty({ pending: {}, tagPending: { 'EXIF:Artist': { op: 'clear' } } }));
  // A cleared location is a staged change, not an absent one — `null` means
  // "remove this", and `undefined` means "untouched".
  assert.ok(!S.draftIsEmpty({ pending: {}, tagPending: {}, gpsPending: null }));
  assert.ok(S.draftIsEmpty({ pending: {}, tagPending: {}, gpsPending: undefined }));
});

test('an untouched field is not the same answer as a deliberately emptied one', () => {
  // The distinction the whole feature rests on. `null` means no draft in the
  // selection mentions this field, so the panel shows what is in the file.
  // `{state:'empty'}` means the user emptied the box on purpose, and showing
  // the file's value instead would silently discard their clear.
  assert.equal(S.resolveDraftField([{ pending: {} }], 'title'), null);
  assert.equal(S.resolveDraftField([], 'title'), null);
  assert.deepEqual(S.resolveDraftField([{ pending: { title: '' } }], 'title'), {
    state: 'empty',
  });
  assert.deepEqual(S.resolveDraftField([{ pending: { title: '   ' } }], 'title'), {
    state: 'empty',
  });
});

test('drafts resolve across a selection the way stored values do', () => {
  const a = { pending: { title: 'Fjord' } };
  const b = { pending: { title: 'Fjord' } };
  const c = { pending: { title: 'Harbour' } };

  assert.deepEqual(S.resolveDraftField([a], 'title'), { state: 'single', value: 'Fjord' });
  assert.deepEqual(S.resolveDraftField([a, b], 'title'), { state: 'single', value: 'Fjord' });
  assert.deepEqual(S.resolveDraftField([a, c], 'title'), { state: 'mixed' });
});

test('a field only some of the selection has drafted is mixed, not single', () => {
  // The photos without a draft would keep whatever they already have, so the
  // selection does not agree. Reporting "single" here would show one photo's
  // typing as though it applied to all of them, and Apply would then write it
  // to all of them.
  const drafted = { pending: { title: 'Fjord' } };
  const untouched = { pending: {} };
  assert.deepEqual(S.resolveDraftField([drafted, untouched], 'title'), { state: 'mixed' });
});

test('drafts never carry a baseline', () => {
  // buildEdit diffs typed values against what the file holds *now*. A stored
  // baseline would keep diffing against a snapshot of the past, so once the
  // file changed on disk a real change could be downgraded to a no-op — a save
  // that reports success and writes nothing.
  for (const key of Object.keys(S.EMPTY_DRAFT)) {
    assert.ok(
      !/baseline/i.test(key),
      `EMPTY_DRAFT should carry no baseline, found "${key}"`
    );
  }
  assert.deepEqual(Object.keys(S.EMPTY_DRAFT).sort(), [
    'gpsPending',
    'pending',
    'tagPending',
  ]);
});
