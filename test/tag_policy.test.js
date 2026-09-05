/**
 * The tag policy, and the agreement between its two copies.
 *
 * `locked_reason` in tauri/src/write.rs is the authority — it is enforced on
 * every write regardless of what the UI does, because the IPC boundary is not
 * trusted. `lockedReason` in www/js/state.js is a mirror, used only to decide
 * whether the All tab draws an edit button.
 *
 * Two copies of a safety rule will drift. This test reads the Rust source and
 * compares it against the JS, so drift fails here rather than showing an edit
 * button for a tag the backend will refuse — or, worse, hiding one it would
 * happily have written.
 *
 * Note the shape of the check: it parses the *real* lists out of write.rs
 * rather than restating them. `field_specs_match_the_frontend` in write.rs is
 * a hard-coded pin that never reads state.js, and it is exactly why the two
 * field lists can drift today.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const S = require('../www/js/state.js');
const rust = fs.readFileSync(
  path.join(__dirname, '..', 'tauri', 'src', 'write.rs'),
  'utf8'
);

/** Pulls the entries out of a `const NAME: &[(&str, &str)] = &[ ... ];` block. */
function rustPairs(name) {
  const start = rust.indexOf(`const ${name}: &[(&str, &str)] = &[`);
  assert.notEqual(start, -1, `could not find ${name} in write.rs`);
  const end = rust.indexOf('];', start);
  const block = rust.slice(start, end);
  return [...block.matchAll(/\(\s*"([^"]+)"\s*,/g)].map((m) => m[1]);
}

/** Pulls the entries out of a `const NAME: &[&str] = &[ ... ];` block. */
function rustStrings(name) {
  const start = rust.indexOf(`const ${name}: &[&str] = &[`);
  assert.notEqual(start, -1, `could not find ${name} in write.rs`);
  const end = rust.indexOf('];', start);
  return [...rust.slice(start, end).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

test('the Rust source was actually parsed', () => {
  // A regex that quietly matched nothing would make every comparison below
  // pass vacuously.
  assert.ok(rustPairs('RENDER_CRITICAL').length > 15);
  assert.ok(rustPairs('UNWRITABLE_GROUPS').length >= 4);
});

test('every tag Rust locks, the UI also locks', () => {
  const cases = [
    ...rustPairs('RENDER_CRITICAL').map((name) => `EXIF:${name}`),
    ...rustPairs('UNWRITABLE_GROUPS').map((group) => `${group}:Something`),
    ...rustPairs('LOCKED_GROUPS').map((group) => `${group}:Something`),
    ...rustStrings('POINTER_SUFFIXES').map((suffix) => `EXIF:Some${suffix}`),
    ...rustStrings('POINTER_NAMES').map((name) => `EXIF:${name}`),
    'SourceFile',
  ];
  const missed = cases.filter((tag) => !S.lockedReason(tag));
  assert.deepEqual(
    missed,
    [],
    'the backend refuses these but the All tab would offer an edit button'
  );
});

test('the strip path preserves only tags the All tab refuses to edit', () => {
  // `-all=` then re-add. If a tag is worth restoring after a wholesale strip
  // it is, by definition, one the photo needs — so it must also be one no
  // single-tag edit can delete. Otherwise "remove everything" is safer than
  // pressing the × next to one row, which would be an absurd place to land.
  for (const arg of rustStrings('STRIP_PRESERVES')) {
    const name = arg.replace(/^-/, '');
    if (name === 'icc_profile') {
      assert.ok(S.lockedReason('ICC_Profile:ProfileDescription'));
      continue;
    }
    assert.ok(
      S.lockedReason(`EXIF:${name}`),
      `${name} is restored after a strip but can be deleted one tag at a time`
    );
  }
});

test('render-critical tags are locked with a reason a person can read', () => {
  for (const tag of ['EXIF:Orientation', 'EXIF:ColorSpace', 'EXIF:BitsPerSample']) {
    const reason = S.lockedReason(tag);
    assert.ok(reason, `${tag} should be locked`);
    // The reason completes "this tag is …" next to the row. A code or a bare
    // "locked" would leave the user no wiser about why.
    assert.ok(reason.length > 12, `${tag}: reason too terse: ${reason}`);
    assert.doesNotMatch(reason, /^[A-Z_]+$/, `${tag}: reason looks like a code`);
  }
});

test('ordinary metadata stays editable', () => {
  for (const tag of [
    'EXIF:UserComment',
    'EXIF:Artist',
    'EXIF:Software',
    'XMP:Label',
    'IPTC:City',
    // These end in "Length" but are ordinary photographic values — the reason
    // the pointer rule cannot be a plain suffix match.
    'EXIF:FocalLength',
    'EXIF:FocalLengthIn35mmFormat',
  ]) {
    assert.equal(S.lockedReason(tag), null, `${tag} should be editable`);
  }
});

test('binary values are not offered as editable text', () => {
  // The inspector shows these as "(binary, N bytes encoded)", a summary rather
  // than a value. Editing it would write the description into the file.
  assert.equal(S.isEditableValue('base64:AAAA'), false);
  assert.equal(S.isEditableValue('Canon EOS R6'), true);
  assert.equal(S.isEditableValue(16), true);
  assert.equal(S.isEditableValue(['sea', 'north']), true);
  assert.equal(S.isEditableValue(['ok', 'base64:AAAA']), false);
});
