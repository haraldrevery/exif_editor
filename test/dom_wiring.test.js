/**
 * DOM wiring.
 *
 * The frontend reaches for elements by id and never checks the result, so a
 * `getElementById` that returns null throws at the moment a user clicks
 * something — or, worse, silently does nothing when the call is inside a
 * `hidden = true` assignment. There is no DOM test harness here, so this reads
 * the sources instead: every id the JS asks for must exist in the markup.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'www/index.html'), 'utf8');
const jsDir = path.join(root, 'www/js');
const js = fs
  .readdirSync(jsDir)
  .filter((name) => name.endsWith('.js'))
  .map((name) => ({ name, text: fs.readFileSync(path.join(jsDir, name), 'utf8') }));

const declared = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

test('the markup and sources were actually read', () => {
  assert.ok(declared.size > 20, `only found ${declared.size} ids in index.html`);
  assert.ok(js.length > 5, `only found ${js.length} frontend sources`);
});

test('every element the frontend asks for exists in the markup', () => {
  const missing = [];
  for (const { name, text } of js) {
    for (const match of text.matchAll(/getElementById\('([^']+)'\)/g)) {
      if (!declared.has(match[1])) missing.push(`${name} → #${match[1]}`);
    }
  }
  assert.deepEqual(missing, [], 'these ids are referenced but not declared');
});

test('a failed batch can show why, not just which files', () => {
  const app = js.find((s) => s.name === 'app.js');
  // "Saved 0 of 12. Failed: a.jpg, b.jpg, c.jpg." is a dead end: there is
  // nothing the user can act on and nothing they can report. The per-file
  // reason is already in the outcome and must reach the screen.
  assert.match(app.text, /showFailureReport/, 'app.js should build a failure report');
  assert.ok(declared.has('status-details'), 'no Details button in the markup');
  assert.ok(declared.has('report-body'), 'no failure report body in the markup');
  assert.match(
    app.text,
    /r\.error \|\|/,
    'the report should carry each file’s error text'
  );
});
