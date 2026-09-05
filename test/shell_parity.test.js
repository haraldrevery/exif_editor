/**
 * Shell parity.
 *
 * The frontend calls `window.NativeAPI` and never learns which shell it is
 * running under. That only holds if every shell implements the same methods —
 * and a method added for Tauri but forgotten in Electron produces
 * `NativeAPI.foo is not a function` at the moment a user clicks something, in
 * the build that was not the one being developed against.
 *
 * These tests read the sources rather than executing them: `native_api.js`
 * needs a `window`, and `preload.js` needs Electron.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const nativeApi = fs.readFileSync(path.join(root, 'www/js/native_api.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'electron/preload.js'), 'utf8');
const electronMain = fs.readFileSync(path.join(root, 'electron/main.js'), 'utf8');
const tauriMain = fs.readFileSync(path.join(root, 'tauri/src/main.rs'), 'utf8');
const serve = fs.readFileSync(path.join(root, 'tauri/src/serve.rs'), 'utf8');

/** Method names declared in one implementation object. */
function methodsIn(source, marker, until) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `could not find ${marker}`);
  const end = source.indexOf(until, start);
  const block = source.slice(start, end === -1 ? undefined : end);
  const names = new Set();
  // `foo() {`, `async foo() {`, `foo: () =>` and `foo,` shorthand.
  for (const match of block.matchAll(/^\s{4}(?:async\s+)?([a-zA-Z]+)\s*[:(]/gm)) {
    names.add(match[1]);
  }
  names.delete('env');
  return names;
}

const tauriMethods = methodsIn(nativeApi, 'const tauriImpl', '/* ── Electron');
const electronMethods = methodsIn(nativeApi, 'const electronImpl', '/* ── Web fallback');
const webMethods = methodsIn(nativeApi, 'const webImpl', 'window.NativeAPI =');

test('the adapter is not empty', () => {
  // A regex that quietly matched nothing would make every assertion below
  // pass vacuously.
  assert.ok(tauriMethods.size > 10, `only found ${tauriMethods.size} Tauri methods`);
});

test('every shell implements the same NativeAPI surface', () => {
  const missingFromElectron = [...tauriMethods].filter((m) => !electronMethods.has(m));
  const missingFromTauri = [...electronMethods].filter((m) => !tauriMethods.has(m));
  assert.deepEqual(missingFromElectron, [], 'methods the Electron shell does not implement');
  assert.deepEqual(missingFromTauri, [], 'methods the Tauri shell does not implement');
});

test('the web fallback covers everything, so it fails politely rather than crashing', () => {
  // Opened in a plain browser the app cannot do anything, but it must say so
  // rather than throw "is not a function".
  const missing = [...tauriMethods].filter((m) => !webMethods.has(m));
  assert.deepEqual(missing, [], 'methods the web fallback does not stub');
});

test('preload exposes exactly what the Electron adapter calls', () => {
  const exposed = new Set(
    [...preload.matchAll(/^\s{2}([a-zA-Z]+):/gm)].map((m) => m[1])
  );
  const used = new Set(
    [...nativeApi.matchAll(/window\.exifAPI\.([a-zA-Z]+)/g)].map((m) => m[1])
  );
  assert.ok(used.size > 10, `only found ${used.size} exifAPI calls`);
  const missing = [...used].filter((m) => !exposed.has(m));
  // Anything here would be `undefined is not a function` in the packaged app.
  assert.deepEqual(missing, [], 'called on exifAPI but not exposed by preload');
});

test('every IPC channel preload uses is handled in the main process', () => {
  const channels = new Set(
    [...preload.matchAll(/invoke\('([a-z_]+)'/g)].map((m) => m[1])
  );
  assert.ok(channels.size > 10, `only found ${channels.size} channels`);
  const handled = new Set([
    ...[...electronMain.matchAll(/ipcMain\.handle\('([a-z_]+)'/g)].map((m) => m[1]),
    // The pass-through list is registered in a loop rather than one by one.
    ...[...electronMain.matchAll(/^\s{2}'([a-z_]+)',$/gm)].map((m) => m[1]),
  ]);
  const missing = [...channels].filter((c) => !handled.has(c));
  assert.deepEqual(missing, [], 'IPC channels with no handler');
});

test('the sidecar implements every command the Electron shell forwards', () => {
  // Commands main.js passes straight through to the core, as opposed to the
  // dialogs it handles itself.
  const forwarded = [...electronMain.matchAll(/^\s{2}'([a-z_]+)',$/gm)].map((m) => m[1]);
  assert.ok(forwarded.length > 8, `only found ${forwarded.length} forwarded commands`);
  const implemented = new Set(
    [...serve.matchAll(/^\s{8}"([a-z_]+)"(?:\s*\|\s*"[a-z_]+")*\s*=>/gm)].map((m) => m[1])
  );
  const missing = forwarded.filter((c) => !implemented.has(c));
  assert.deepEqual(missing, [], 'commands the sidecar does not implement');
});

test('the two shells expose the same command names', () => {
  // Tauri registers commands by function name; the sidecar dispatches by
  // string. They must agree, or a feature works in one build and not the other.
  const tauriCommands = new Set(
    [...tauriMain.matchAll(/#\[tauri::command\]\s*(?:pub\s+)?(?:async\s+)?fn\s+([a-z_]+)/g)].map(
      (m) => m[1]
    )
  );
  assert.ok(tauriCommands.size > 10, `only found ${tauriCommands.size} Tauri commands`);
  const sidecarCommands = new Set(
    [...serve.matchAll(/^\s{8}"([a-z_]+)"(?:\s*\|\s*"[a-z_]+")*\s*=>/gm)].map((m) => m[1])
  );
  // Shell-specific by nature: the dialogs and the renderer diagnostic never
  // reach the core, and the sidecar has no window to read argv for.
  // `set_dirty` joins them because unsaved drafts never leave the renderer —
  // the core has no idea they exist, and the only consumer is whichever shell
  // owns the window it has to refuse to close.
  // `export_csv` joins them for the same reason as the pickers: it opens a
  // native save dialog and writes to what came back. The core deliberately
  // does not have it — every path the core touches is confined to the open
  // folder, and an export is by definition outside it, so the one command that
  // writes elsewhere is the one whose destination the renderer cannot name.
  const shellOnly = new Set([
    'choose_gpx_file',
    'export_csv',
    'initial_folder',
    'report_renderer',
    'set_dirty',
  ]);
  const missing = [...tauriCommands].filter(
    (c) => !sidecarCommands.has(c) && !shellOnly.has(c)
  );
  assert.deepEqual(missing, [], 'Tauri commands the sidecar does not provide');
});
