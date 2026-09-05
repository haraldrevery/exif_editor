/**
 * Theme completeness.
 *
 * The light theme overrides a subset of the dark tokens. A colour defined in
 * `:root` but forgotten in the light block silently keeps its dark value —
 * which in a light window is invisible text on a white field. Nobody notices
 * until someone runs the app on a machine set to light.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'www', 'css', 'main.css'), 'utf8');

function tokensIn(block) {
  return new Set([...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
}

const rootBlock = css.slice(css.indexOf(':root {'), css.indexOf('@media (prefers-color-scheme: light)'));
const lightBlock = css.slice(
  css.indexOf('@media (prefers-color-scheme: light)'),
  css.indexOf('* {')
);

/** Tokens whose value is a measurement or a font face, not a colour.
 *
 * Named precisely rather than by prefix: `--text`, `--text-dim` and
 * `--text-faint` are colours despite starting with "text", and treating them
 * as measurements would have excused exactly the omission this file exists to
 * catch. */
const NOT_A_COLOUR = /^--(space-\d|radius|font|panel-width|divider-width|line-height)/;

test('the theme blocks were actually found', () => {
  assert.ok(tokensIn(rootBlock).size > 10, 'no tokens parsed from :root');
  assert.ok(tokensIn(lightBlock).size > 5, 'no tokens parsed from the light block');
});

test('every colour token has a light value', () => {
  const dark = [...tokensIn(rootBlock)].filter((t) => !NOT_A_COLOUR.test(t));
  const light = tokensIn(lightBlock);
  const missing = dark.filter((t) => !light.has(t));
  // Each of these would render as its dark value on a light background.
  assert.deepEqual(missing, [], 'colour tokens with no light-theme override');
});

test('sizes and faces are shared, not duplicated per theme', () => {
  // Redefining a measurement per theme is how the two drift apart.
  const light = [...tokensIn(lightBlock)];
  const measurements = light.filter((t) => NOT_A_COLOUR.test(t));
  assert.deepEqual(measurements, [], 'non-colour tokens redefined in the light theme');
});

test('icons are drawn as masks so one file serves both themes', () => {
  // A themed <img> would need a light and a dark copy of every glyph; the mask
  // takes currentColor instead, which is why the set is single-colour SVG.
  assert.match(css, /\.icon\s*\{[^}]*background-color:\s*currentColor/);
  const maskRules = [...css.matchAll(/\.icon-[a-z0-9-]+\s*\{/g)].length;
  assert.ok(maskRules >= 15, `only ${maskRules} icon rules found`);
  // Every icon rule must set both the standard and the WebKit property:
  // WebKitGTK still needs the prefix, and the Tauri build is WebKitGTK.
  const standard = [...css.matchAll(/\n  mask-image:/g)].length;
  const webkit = [...css.matchAll(/\n  -webkit-mask-image:/g)].length;
  assert.equal(standard, webkit, 'mask-image and -webkit-mask-image are out of step');
});

test('the brand faces are declared with a fallback stack', () => {
  assert.match(css, /@font-face[\s\S]*?font-family:\s*"HaraldText"/);
  assert.match(css, /@font-face[\s\S]*?font-family:\s*"HaraldMono"/);
  // A failed font load must degrade to a readable system face rather than to
  // the browser default serif.
  assert.match(css, /--font:\s*"HaraldText",[^;]*system-ui/);
  assert.match(css, /--font-mono:\s*"HaraldMono",[^;]*ui-monospace/);
});
