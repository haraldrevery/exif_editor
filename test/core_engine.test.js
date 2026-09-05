/**
 * The Electron shell talking to the real sidecar.
 *
 * `core_client.test.js` covers the pure helpers — line framing, id matching —
 * without spawning anything, which is right for those. It leaves
 * `createCoreClient` itself, and therefore the whole Electron backend path,
 * with no coverage at all: the restart, the library root that lives in the
 * sidecar's process memory, and the stream error handling that decides whether
 * a crashed engine costs one action or the entire app.
 *
 * These spawn the actual `revery-exif-core` binary. They skip — visibly, via
 * node's own skip reporting — when it has not been built, since it is a
 * `cargo build` away and not committed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { spawn } = require('node:child_process');

const { createCoreClient } = require('../electron/core_client.js');

/**
 * A client that also hands back the children it spawns.
 *
 * Killing the engine is the whole point of this file, and the client
 * deliberately does not expose a way to do it — a method that kills the engine
 * has no business sitting on the object the app uses. The spawn seam is how
 * a test reaches one instead.
 */
function trackedClient(executable) {
  const children = [];
  const core = createCoreClient(executable, {
    spawn: (...args) => {
      const child = spawn(...args);
      children.push(child);
      return child;
    },
  });
  return {
    core,
    children,
    /** Kills the engine the way the OS would. */
    kill() {
      const live = children[children.length - 1];
      if (live) live.kill('SIGKILL');
    },
  };
}

const root = path.join(__dirname, '..');
const CORE = ['release', 'debug']
  .map((profile) => path.join(root, 'tauri', 'target', profile, 'revery-exif-core'))
  .find((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch (_) {
      return false;
    }
  });

const FIXTURES = path.join(root, 'test', 'fixtures');
const haveEngine = Boolean(CORE) && fs.existsSync(path.join(FIXTURES, 'north_gps.jpg'));

/** A scratch folder holding copies of the fixtures, removed by the caller. */
function scratch(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `revery-core-${name}-`));
  for (const file of fs.readdirSync(FIXTURES)) {
    if (file.endsWith('.jpg')) {
      fs.copyFileSync(path.join(FIXTURES, file), path.join(dir, file));
    }
  }
  return dir;
}

test('the engine answers a request and reports its version', { skip: !haveEngine }, async () => {
  const { core } = trackedClient(CORE);
  try {
    const version = await core.call('engine_version');
    assert.match(String(version), /^\d+\.\d+/, `unexpected version: ${version}`);
  } finally {
    core.dispose();
  }
});

test('a folder opens and its photos come back', { skip: !haveEngine }, async () => {
  const dir = scratch('open');
  const { core } = trackedClient(CORE);
  try {
    const entries = await core.call('open_library', { path: dir });
    assert.ok(entries.length > 0, 'no photos were listed');
    assert.ok(
      entries.every((e) => typeof e.path === 'string' && typeof e.name === 'string'),
      'an entry is missing its path or name'
    );
  } finally {
    core.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The failure this whole file exists for.
 *
 * The sidecar holds the open folder in its own memory. A restarted engine has
 * none, so every path-taking command afterwards failed with "No folder is
 * open" — for the rest of the session, with nothing on screen saying why. The
 * client now replays the last `open_library` before the next command that
 * needs a root.
 */
test('a restarted engine re-opens the folder by itself', { skip: !haveEngine }, async () => {
  const dir = scratch('restart');
  const { core, kill } = trackedClient(CORE);
  try {
    const before = await core.call('open_library', { path: dir });
    assert.ok(before.length > 0);
    const paths = before.slice(0, 1).map((e) => e.path);

    // What an OOM kill, or a user with a task manager, does.
    kill();
    // `exit` is delivered on the next tick or later, so a command issued in
    // the meantime is written into a pipe nobody is reading and fails once.
    // That is correct and is reported as unconfirmed; recovery is the *next*
    // command's job, and deliberately not a retry — retrying a write is the
    // double-apply the date shift cannot survive.
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Reads a path, so it needs the root the dead process was holding.
    const metadata = await core.call('read_metadata', { paths });
    assert.equal(metadata.length, 1, 'the re-opened engine did not read the file');
    assert.ok(metadata[0].SourceFile, 'no SourceFile in the response');

    // And the folder really is open again, rather than the read having
    // succeeded by some other route.
    const again = await core.call('rescan_library');
    assert.equal(again.length, before.length, 'the folder was not actually re-opened');
  } finally {
    core.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A command issued in the instant between the engine dying and Node noticing.
 *
 * It cannot succeed, and the point is only that it fails *honestly* — marked
 * unconfirmed, so the renderer does not claim nothing was written — and that
 * it does not poison what comes after it.
 */
test('a command racing the engine\'s death fails, and the next one works', { skip: !haveEngine }, async () => {
  const dir = scratch('race');
  const { core, kill } = trackedClient(CORE);
  try {
    const before = await core.call('open_library', { path: dir });
    kill();
    await assert.rejects(core.call('rescan_library'), /E_UNCONFIRMED:/);

    // The session recovers rather than staying broken.
    const after = await core.call('rescan_library');
    assert.equal(after.length, before.length);
  } finally {
    core.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A request in flight when the engine dies must be marked *unconfirmed*.
 *
 * The renderer used to call every rejection "Nothing was changed", which for a
 * batch cut off halfway is untrue and invites a retry — and the date shift is
 * cumulative. `native_api.js` reads this marker back into `error.unconfirmed`.
 */
test('a request killed in flight is reported as unconfirmed', { skip: !haveEngine }, async () => {
  const dir = scratch('inflight');
  const { core, kill } = trackedClient(CORE);
  try {
    await core.call('open_library', { path: dir });
    const pending = core.call('writable_tags'); // seconds of ExifTool
    setTimeout(kill, 40);
    await assert.rejects(pending, (error) => {
      assert.match(
        error.message,
        /E_UNCONFIRMED:/,
        `a lost request must be marked unconfirmed, got: ${error.message}`
      );
      return true;
    });
  } finally {
    core.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an engine that cannot be spawned rejects rather than crashing', async () => {
  // The old client registered no 'error' listener on the child, and an
  // 'error' event without one is an uncaught exception — so a spawn failure
  // took the whole main process down instead of failing one action.
  const { core } = trackedClient(path.join(os.tmpdir(), 'definitely-not-an-engine'));
  try {
    await assert.rejects(core.call('engine_version'), /metadata engine/);
  } finally {
    core.dispose();
  }
});

test('nothing is sent after dispose', { skip: !haveEngine }, async () => {
  const { core } = trackedClient(CORE);
  await core.call('engine_version');
  core.dispose();
  // Without the flag, `call` would cheerfully spawn a fresh engine after quit.
  await assert.rejects(core.call('engine_version'), /shut down/);
});


/* ── The identity guard, with a child under full control ─────────────────────
   The tests above drive the real binary, which is right for behaviour but
   cannot force the *ordering* this guard exists for: a dead child emitting
   after its replacement is already running. EPIPE is queued by the OS, so
   whether it lands before or after a restart is not something a test can ask
   for. A fake child can emit it on demand.                                  */

const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

/** Enough of a ChildProcess for `createCoreClient` to drive. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  // Nothing reads stdin, so writes must not pile up unbounded.
  child.stdin.resume();
  return child;
}

test('a dead child emitting late cannot drop its replacement', () => {
  const spawned = [];
  const core = createCoreClient('/unused', {
    spawn: () => {
      const child = fakeChild();
      spawned.push(child);
      return child;
    },
  });

  // First engine, one request in flight.
  const first = core.call('engine_version');
  assert.equal(spawned.length, 1);
  const dead = spawned[0];

  // It dies. The in-flight request fails, unconfirmed.
  dead.emit('exit', null);
  const firstSettled = assert.rejects(first, /E_UNCONFIRMED:/);

  // A replacement starts and takes a request of its own.
  const second = core.call('engine_version');
  assert.equal(spawned.length, 2, 'the client did not start a replacement');
  const live = spawned[1];

  // **Now the dead child's queued EPIPE arrives.** Unguarded, this reached
  // `failChild` and dropped whatever was current — aborting the live
  // engine's request and marking the session as needing a re-open.
  dead.stdin.emit('error', new Error('write EPIPE'));
  dead.emit('exit', null);

  // The replacement is untouched and still answering.
  live.stdout.write(JSON.stringify({ id: 2, ok: true, result: '13.59' }) + '\n');

  return Promise.all([
    firstSettled,
    second.then(
      (value) => assert.equal(value, '13.59', 'the live engine returned the wrong value'),
      (error) => assert.fail(`a dead child aborted the live engine's request: ${error.message}`)
    ),
  ]).then(() => core.dispose());
});

test('a superseded child cannot pollute the next error message', () => {
  const spawned = [];
  const core = createCoreClient('/unused', {
    spawn: () => {
      const child = fakeChild();
      spawned.push(child);
      return child;
    },
  });

  const first = core.call('engine_version').catch(() => {});
  const dead = spawned[0];
  dead.emit('exit', null);

  const second = core.call('engine_version');
  const live = spawned[1];
  // The dead engine's last words, arriving after it was replaced.
  dead.stderr.write('a message from the previous process\n');
  live.emit('exit', 3);

  return Promise.all([
    first,
    assert.rejects(second, (error) => {
      assert.doesNotMatch(
        error.message,
        /previous process/,
        `a dead child's stderr was attributed to its replacement: ${error.message}`
      );
      return true;
    }),
  ]).then(() => core.dispose());
});
