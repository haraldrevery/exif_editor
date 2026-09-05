/**
 * The resizable panel.
 *
 * The panel width is set in three places that have to agree: a default in
 * `:root`, an override for narrow windows, and an inline property written by
 * `divider.js` while dragging. Two of the three ways to get this wrong fail
 * *silently* — the panel simply stops responding to the drag at some window
 * size, with nothing thrown and nothing logged — so they are pinned here
 * rather than left to be noticed.
 *
 * Reads the sources rather than executing them: there is no DOM harness here,
 * and the interesting properties are structural.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'www/css/main.css'), 'utf8');
const divider = fs.readFileSync(path.join(root, 'www/js/divider.js'), 'utf8');
const prefs = fs.readFileSync(path.join(root, 'www/js/prefs.js'), 'utf8');
const grid = fs.readFileSync(path.join(root, 'www/js/grid.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'www/index.html'), 'utf8');

/** Every frontend source, for the checks that must hold across all of them. */
const sources = Object.fromEntries(
  fs
    .readdirSync(path.join(root, 'www/js'))
    .filter((name) => name.endsWith('.js'))
    .map((name) => [name, fs.readFileSync(path.join(root, 'www/js', name), 'utf8')])
);

/** The body of the first rule whose selector matches, braces excluded. */
function ruleBody(selector) {
  const at = css.indexOf(`${selector} {`);
  assert.notEqual(at, -1, `no \`${selector}\` rule in main.css`);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

test('the sources were actually read', () => {
  assert.ok(css.length > 1000, 'main.css looks empty');
  assert.ok(divider.length > 500, 'divider.js looks empty');
});

/* ── The three places the width is set ───────────────────────────────────── */

test('the layout sizes the panel from the variable, not a fixed track', () => {
  // The inline property divider.js writes only reaches the layout if the
  // layout reads the variable. A literal width here would make the drag
  // update a variable nothing consumes — the handle moves, the panel does not.
  const app = ruleBody('#app');
  assert.match(app, /grid-template-columns:[^;]*var\(--panel-width\)/, '#app ignores --panel-width');
  assert.match(app, /grid-template-columns:[^;]*var\(--divider-width\)/, 'no track for the divider');
  assert.match(app, /"grid\s+divider\s+panel"/, 'the divider has no grid area');
});

test('the narrow-window override touches the variable, never the template', () => {
  // This is the regression worth a test of its own. `grid-template-columns` in
  // a media query outranks an inline *custom property*, because they are
  // different declarations — so a panel the user had dragged would snap back
  // to 300px below 980px wide and silently refuse to move, while the variable
  // it was set from still held the right number. Nothing throws; the divider
  // just stops working at one window size.
  const at = css.indexOf('@media (max-width: 980px)');
  assert.notEqual(at, -1, 'the narrow-window media query has gone');
  const block = css.slice(at, css.indexOf('}\n}', at) + 3);

  assert.match(block, /--panel-width:/, 'the override should set the variable');
  assert.doesNotMatch(
    block,
    /grid-template-columns/,
    'setting the template here would outrank the inline width divider.js writes'
  );
});

test('divider.js writes the width where it outranks both stylesheet rules', () => {
  // An inline style on the document element beats `:root` and beats the media
  // query. Anything else — a class, a stylesheet rule, a style element — loses
  // to one of them at some window size.
  assert.match(
    divider,
    /document\.documentElement/,
    'the width must land on the element :root refers to'
  );
  assert.match(
    divider,
    /style\.setProperty\(\s*['"]--panel-width['"]/,
    'the width should be written as an inline custom property'
  );
});

/* ── Dragging ────────────────────────────────────────────────────────────── */

test('the drag is tracked by pointer capture, not by listening on the document', () => {
  // With document listeners, a pointer that outruns the repaint and leaves the
  // window stops delivering events: the divider freezes mid-drag and never
  // sees the button-up that happened outside, so it still believes it is being
  // dragged when the pointer returns. Capture routes every event to the
  // divider until it is released, wherever the pointer goes.
  assert.match(divider, /setPointerCapture/, 'no pointer capture');
  assert.match(divider, /releasePointerCapture/, 'capture is taken but never released');
  assert.doesNotMatch(
    divider,
    /document\.addEventListener\(\s*['"](?:mousemove|pointermove)['"]/,
    'a document-level move listener is the failure mode capture exists to avoid'
  );
});

test('a lost capture ends the drag', () => {
  // The window losing focus mid-drag, or the OS claiming the pointer, revokes
  // capture without a pointerup. Without this the divider is left stuck to the
  // cursor with no button held.
  assert.match(divider, /pointercancel/, 'no pointercancel handler');
  assert.match(divider, /lostpointercapture/, 'no lostpointercapture handler');
});

test('width changes are coalesced to one per frame', () => {
  // Every change reflows the grid behind it, and a pointer delivers events
  // faster than the compositor draws.
  assert.match(divider, /requestAnimationFrame/, 'the drag is not frame-throttled');
});

/* ── Persistence ─────────────────────────────────────────────────────────── */

test('storage failures cannot take the frontend down at boot', () => {
  // The Electron shell loads the page from a file:// origin, where storage is
  // a browser decision rather than something the app controls, and any shell
  // can throw on a full quota. Preferences are restored during boot, before a
  // folder is open, so an uncaught throw here costs the whole window — not
  // just the setting.
  const reads = [...prefs.matchAll(/localStorage/g)];
  assert.ok(reads.length > 0, 'no persistence at all');
  for (const match of reads) {
    // Every access must sit inside a try block somewhere above it.
    const before = prefs.slice(0, match.index);
    const lastTry = before.lastIndexOf('try {');
    const lastCatch = before.lastIndexOf('catch');
    assert.ok(
      lastTry > lastCatch,
      'a localStorage access is not guarded by try/catch'
    );
  }
});

test('storage is reached through prefs.js, not touched directly', () => {
  // One wrapper, so a second consumer cannot quietly reintroduce an unguarded
  // access. The guard above only checks the file it knows about.
  for (const [name, source] of Object.entries(sources)) {
    if (name === 'prefs.js') continue;
    assert.doesNotMatch(
      source,
      /localStorage/,
      `${name} should go through ExifPrefs rather than localStorage directly`
    );
  }
});

/* ── Orientation ─────────────────────────────────────────────────────────── */

test('suppressing EXIF orientation is scoped to the images that need it', () => {
  // The narrowest bug in this change, and one the development machine cannot
  // show. `image-orientation: none` exists to stop an *extracted* preview
  // blob's own rotation being applied on top of the parent file's. Applied to
  // every image it also un-rotates the ones the webview had already got right
  // — and only in Chromium, which honours the property. WebKitGTK ignores it,
  // so the Tauri build looks perfectly correct while every portrait photo in
  // the Electron build lies on its side, from a stylesheet they share.
  //
  // The scope is the `[data-orient]` attribute, which the JS sets only for
  // extracted previews.
  const rules = [...css.matchAll(/([^{}]*)\{([^}]*image-orientation\s*:\s*none[^}]*)\}/g)];
  assert.ok(rules.length > 0, 'no image-orientation suppression at all');
  for (const [, selector] of rules) {
    assert.match(
      selector,
      /\[data-orient\]/,
      `image-orientation: none must be scoped to [data-orient], got "${selector.trim()}"`
    );
  }
});

test('the attribute is set for every extracted preview, including an upright one', () => {
  // `> 1` would leave an unrotated extracted blob without the attribute, and
  // so without the suppression — which is the one case where a blob carrying a
  // stray orientation of its own gets applied unopposed. `>= 1` is what makes
  // the CSS scope above line up exactly with "came from an extraction".
  for (const file of ['www/js/grid.js', 'www/js/preview.js']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const uses = [...source.matchAll(/orientation\s*(>=?)\s*1\)?\s*(?:image|img)?\.?dataset/g)];
    assert.ok(uses.length > 0, `${file} never sets data-orient`);
    for (const [, operator] of uses) {
      assert.equal(operator, '>=', `${file} gates data-orient on "> 1" rather than ">= 1"`);
    }
  }
});

/* ── Thumbnail size ──────────────────────────────────────────────────────── */

test('the quarter-turn fit is measured, not pinned to one tile size', () => {
  // The scale that keeps a rotated thumbnail inside its box is derived from
  // that box's proportions — and the name row's height is fixed by its font,
  // so the ratio moves with tile size (0.80 at 120px against 0.92 at 288px).
  // A constant is correct at exactly one size and silently clips rotated
  // thumbnails at the others, which is easy to miss because unrotated ones
  // look perfect throughout.
  assert.match(grid, /--quarter-turn-fit/, 'the grid never sets the fit factor');
  assert.match(
    grid,
    /clientWidth|getBoundingClientRect/,
    'the fit factor should come from measuring a real tile'
  );
});

test('the fit fallback is declared where an inline override can beat it', () => {
  // grid.js writes the measured value as an inline style on the scroller.
  // Declaring the fallback on `.tile-image` would set the property *on* the
  // element that consumes it, overriding the inherited one — pinning every
  // tile size to the fallback and making the measurement do nothing.
  // Comments stripped first: they discuss `.tile-image` at length, and a
  // selector read straight out of the raw text picks up the prose.
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const at = bare.indexOf('--quarter-turn-fit:');
  assert.notEqual(at, -1, 'no fallback declared');
  // The selector runs from the end of the previous rule to the brace that
  // *opens* the one holding the property — searching forward from the property
  // finds the next rule's brace instead, and reads the wrong selector.
  const opens = bare.lastIndexOf('{', at);
  const selector = bare.slice(bare.lastIndexOf('}', opens) + 1, opens).trim();
  assert.ok(selector.length, 'could not read the selector');
  assert.doesNotMatch(
    selector,
    /\.tile-image/,
    'the fallback must not sit on the element that reads it'
  );
});

test('the size control is a fixed set of steps the buttons cannot leave', () => {
  assert.match(grid, /TILE_SIZES\s*=\s*\[/, 'no size range');
  assert.match(grid, /DEFAULT_TILE_SIZE\s*=\s*168/, 'the default should stay 168');
  // An unrecognised stored size must fall back rather than be adopted: it
  // would come from a future build's range, and the fit factor and column
  // arithmetic are only known-good at the declared steps.
  assert.match(grid, /TILE_SIZES\.includes\(/, 'a stored size is not validated');
  for (const id of ['thumb-smaller', 'thumb-larger']) {
    assert.match(html, new RegExp(`id="${id}"`), `no #${id} in the markup`);
  }
});

/* ── Preview mode's toolbar ──────────────────────────────────────────────── */

test('there is exactly one way in and out of preview mode', () => {
  // The toolbar toggle. A second button in the preview bar meant two controls
  // for one mode change, and two places to keep in step with each other.
  assert.match(html, /id="preview-toggle"/, 'no preview toggle');
  assert.doesNotMatch(html, /id="preview-close"/, 'the preview bar grew a second exit');

  // The label is a separate element because app.js swaps it; writing the word
  // straight into the button would mean rebuilding the icon alongside it.
  assert.match(html, /id="preview-toggle-label"/, 'the toggle has no swappable label');
  const app = sources['app.js'];
  assert.match(app, /previewToggleLabel\.textContent\s*=/, 'the label is never swapped');
  assert.match(app, /icon-table/, 'the toggle never takes the grid icon');
});

test('the thumbnail-size buttons are hidden while previewing, not just disabled', () => {
  // They resize a grid that is not on screen. Disabling would leave a dead
  // control sitting in the toolbar instead of giving the space back.
  assert.match(html, /id="thumb-size"/, 'the size group has no id to hide it by');
  assert.match(sources['app.js'], /thumbSize\.hidden\s*=/, 'the size group is never hidden');
});

test('a preview that closes itself tells the app, and the app can take it twice', () => {
  // preview.js closes itself when the photo being shown is filtered away. It
  // knows nothing about the scroller, the grid's tiles or the toolbar, so
  // closing silently left all three in preview state with a blank window. The
  // guard is what stops the callback and the button closing each other.
  const preview = sources['preview.js'];
  assert.match(preview, /onClose/, 'preview.js never reports closing itself');
  const app = sources['app.js'];
  assert.match(app, /onClose:\s*exitPreview/, 'the app does not listen for it');
  assert.match(
    app,
    /if \(!previewMode\) return;/,
    'exitPreview must be safe to call twice, or the two closers recurse'
  );
});

/* ── The [hidden] trap ───────────────────────────────────────────────────── */

test('anything the app hides has a [hidden] rule to beat its own display', () => {
  // The UA stylesheet's `[hidden] { display: none }` is the weakest rule there
  // is: any selector of the app's own that sets `display` outranks it, and the
  // attribute then does nothing at all. Nothing throws, nothing logs — the
  // element simply stays on screen with `hidden` dutifully set.
  //
  // This has now caught three elements (`#pending-bar`, `#preview`, and the
  // thumbnail-size group), so it is worth a test rather than a third comment.
  //
  // The list is derived from the markup: an element that ships with `hidden`
  // is by definition one the app toggles. The two additions are toggled only
  // from JS and so never appear hidden in the source.
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');

  /** Selectors that set `display`, and the ones that restate it for [hidden]. */
  const setsDisplay = new Set();
  const guarded = new Set();
  for (const rule of bare.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selector = rule[1].trim();
    if (!/(^|;)\s*display\s*:/.test(rule[2])) continue;
    for (const part of selector.split(',').map((s) => s.trim())) {
      if (part.includes('[hidden]')) guarded.add(part.replace('[hidden]', ''));
      else setsDisplay.add(part);
    }
  }

  // Every tag in the markup that carries a bare `hidden` attribute, plus the
  // two the app hides only at runtime.
  const togglable = [
    { id: 'thumb-size', classes: ['button-group'] },
    { id: 'grid-scroll', classes: [] },
  ];
  // `\shidden` rather than `\bhidden\b`: the latter also matches the `hidden`
  // inside `aria-hidden`, which every decorative icon in the app carries.
  for (const tag of html.matchAll(/<[a-z]+\b[^>]*\shidden(?=[\s/>])[^>]*>/g)) {
    const id = (tag[0].match(/id="([^"]+)"/) || [])[1];
    const classes = ((tag[0].match(/class="([^"]+)"/) || [])[1] || '').split(/\s+/).filter(Boolean);
    if (id || classes.length) togglable.push({ id, classes });
  }
  assert.ok(togglable.length > 4, `only found ${togglable.length} hideable elements`);

  const unguarded = [];
  for (const element of togglable) {
    // Every selector that could give this element a `display`.
    const candidates = [
      element.id ? `#${element.id}` : null,
      ...element.classes.map((name) => `.${name}`),
    ].filter(Boolean);
    for (const selector of candidates) {
      if (!setsDisplay.has(selector)) continue;
      if (guarded.has(selector)) continue;
      unguarded.push(`${selector} sets display but has no ${selector}[hidden] rule`);
    }
  }
  assert.deepEqual(unguarded, [], 'these elements will ignore the hidden attribute');
});

/* ── Accessibility ───────────────────────────────────────────────────────── */

test('the divider is reachable and adjustable without a pointer', () => {
  const at = html.indexOf('id="divider"');
  assert.notEqual(at, -1, 'no divider in the markup');
  // The attribute's own tag: back to the `<` that opens it, forward to the `>`
  // that closes it. Slicing on literal indentation instead makes the test
  // fail on a reformat rather than on a regression.
  const tag = html.slice(html.lastIndexOf('<', at), html.indexOf('>', at));
  assert.match(tag, /role="separator"/, 'the divider needs a role');
  assert.match(tag, /tabindex="0"/, 'a separator is only focusable with a tabindex');
  assert.match(tag, /aria-orientation="vertical"/, 'no orientation');
  // Arrow keys are what a focusable separator is expected to respond to.
  assert.match(divider, /ArrowLeft/, 'no keyboard adjustment');
  assert.match(divider, /ArrowRight/, 'no keyboard adjustment');
  assert.match(divider, /aria-valuenow/, 'the current width is not exposed');
});

test('the drag target is wider than the line it draws', () => {
  // A 1px hit area is not a hit area. The visible hairline stays 1px and the
  // grabbable region is widened with a pseudo-element.
  assert.match(css, /#divider::before/, 'no widened hit area');
  assert.match(ruleBody('#divider::before'), /inset:\s*0\s+-\d/, 'the hit area is not widened');
  assert.match(ruleBody('#divider'), /cursor:\s*col-resize/, 'no resize cursor');
  // Otherwise a touch drag is claimed by the scroller before the pointer
  // handlers ever see it.
  assert.match(ruleBody('#divider'), /touch-action:\s*none/, 'no touch-action');
});
